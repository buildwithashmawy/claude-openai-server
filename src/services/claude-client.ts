import { query, type SDKMessage, type Options } from "@anthropic-ai/claude-agent-sdk";

export interface Message {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
}

interface ContentPart {
  type: string;
  text?: string;
}

const MAX_TURNS = parseInt(process.env.MAX_TURNS || "30", 10);
const CWD = process.env.CWD || process.cwd();
const ADDITIONAL_DIRS = process.env.ADDITIONAL_DIRS
  ? process.env.ADDITIONAL_DIRS.split(",").map((d) => d.trim()).filter(Boolean)
  : [];

/**
 * Normalize content — Cursor/OpenAI can send either:
 *   "hello"
 *   [{type: "text", text: "hello"}]
 */
function textOf(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p.type === "text" && p.text)
      .map((p) => p.text!)
      .join("\n");
  }
  return String(content);
}

/**
 * Build a clean env without CLAUDE_CODE_* vars to avoid
 * "nested session" issues when running inside Claude Code.
 */
function cleanEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === "CLAUDECODE" || key.startsWith("CLAUDE_CODE_")) continue;
    env[key] = value;
  }
  return env;
}

/**
 * Extract system prompt and the last user message from OpenAI messages.
 * Prior conversation turns are folded into the system prompt as context.
 */
function messagesToPrompt(messages: Message[]): {
  systemPrompt: string | undefined;
  prompt: string;
} {
  let systemParts: string[] = [];
  const turns: Message[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      systemParts.push(textOf(msg.content));
    } else {
      turns.push(msg);
    }
  }

  // Build system prompt: original system + prior context
  let systemPrompt: string | undefined;
  if (systemParts.length > 0) {
    systemPrompt = systemParts.join("\n\n");
  }

  // If there's prior conversation context (not just the last user msg),
  // prepend it to the system prompt so Claude has the full context.
  if (turns.length > 1) {
    const context = turns
      .slice(0, -1)
      .map((m) => `[${m.role}]: ${textOf(m.content)}`)
      .join("\n\n");
    const contextBlock = `<conversation_history>\n${context}\n</conversation_history>`;
    systemPrompt = systemPrompt
      ? `${systemPrompt}\n\n${contextBlock}`
      : contextBlock;
  }

  // The prompt is just the last user message content
  const lastUser = [...turns].reverse().find((m) => m.role === "user");
  const prompt = lastUser
    ? textOf(lastUser.content)
    : turns.length > 0
      ? textOf(turns[turns.length - 1].content)
      : "Hello";

  return { systemPrompt, prompt };
}

/**
 * Only pass model to the SDK if it looks like a valid Anthropic model name.
 * Cursor sends things like "claude-code", "gpt-4", etc. which are not
 * valid and could cause the SDK subprocess to fail silently.
 */
function resolveModel(model?: string): string | undefined {
  if (!model) return undefined;
  if (/^claude-(sonnet|opus|haiku)-/.test(model)) return model;
  if (/^claude-\d/.test(model)) return model;
  process.stderr.write(
    `[claude-sdk] Ignoring unsupported model "${model}", using SDK default\n`
  );
  return undefined;
}

function baseOptions(
  systemPrompt: string | undefined,
  model?: string
): Options {
  const resolvedModel = resolveModel(model);

  const opts: Options = {
    maxTurns: MAX_TURNS,
    cwd: CWD,
    additionalDirectories: ADDITIONAL_DIRS,
    env: cleanEnv(),
    persistSession: false,
    // Load user settings so the CLI has configured tools/directories.
    settingSources: ["user", "project", "local"],
    // Bypass ALL permission checks. This is the correct approach for a
    // proxy server — the CLI runs as a subprocess, not interactively.
    // allowDangerouslySkipPermissions unlocks the bypassPermissions mode
    // (which is otherwise blocked when running as root on a VPS).
    allowDangerouslySkipPermissions: true,
    permissionMode: "bypassPermissions",
    debug: !!process.env.DEBUG,
    stderr: (data: string) => {
      process.stderr.write(`[claude-sdk] ${data}`);
    },
  };

  if (systemPrompt) {
    opts.systemPrompt = systemPrompt;
  }

  if (resolvedModel) {
    opts.model = resolvedModel;
  }

  return opts;
}

/**
 * Run a query and collect the result text. Used by both streaming and
 * non-streaming paths so that the generator is always iterated in the
 * same async context it was created (avoiding a timing race in the SDK).
 */
async function runQuery(
  prompt: string,
  opts: Options,
  onMessage?: (msg: SDKMessage) => void,
): Promise<string> {
  const q = query({ prompt, options: opts });
  let resultText = "";

  try {
    for await (const message of q) {
      const sub = ("subtype" in message) ? `.${(message as {subtype: string}).subtype}` : "";
      process.stderr.write(`[claude-sdk] msg: ${message.type}${sub}\n`);

      if (onMessage) onMessage(message);

      // Log tool use for debugging
      if (message.type === "tool_use_summary") {
        const summary = message as Record<string, unknown>;
        process.stderr.write(`[claude-sdk] tool: ${JSON.stringify(summary).slice(0, 300)}\n`);
      }

      if (message.type === "result") {
        if (message.subtype === "success") {
          resultText = message.result;
        } else {
          // Log error results (max_turns, errors, etc.)
          const errResult = message as Record<string, unknown>;
          process.stderr.write(`[claude-sdk] result error: ${JSON.stringify(errResult).slice(0, 500)}\n`);
        }
      }
    }
  } catch (err) {
    // Subprocess may exit with code 1 after delivering the result (e.g. not logged in).
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[claude-sdk] Stream error (${resultText ? "non-fatal" : "fatal"}): ${msg}\n`);
    if (!resultText) throw err;
  }

  return resultText;
}

/**
 * Non-streaming: run query and return the final result text.
 */
export async function createCompletion(
  messages: Message[],
  model?: string
): Promise<string> {
  const { systemPrompt, prompt } = messagesToPrompt(messages);
  const opts = baseOptions(systemPrompt, model);
  process.stderr.write(`[claude-sdk] Non-streaming query: "${prompt.slice(0, 80)}..."\n`);
  return runQuery(prompt, opts);
}

/**
 * Format a tool call announcement with rich context extracted from its input.
 */
function formatToolAnnouncement(name: string, inputJson: string): string {
  try {
    const input = JSON.parse(inputJson);
    switch (name) {
      case "Read":
        return `\n\n**Reading** \`${input.file_path}\`\n\n`;
      case "Edit":
        return `\n\n**Editing** \`${input.file_path}\`\n\n`;
      case "Write":
        return `\n\n**Writing** \`${input.file_path}\`\n\n`;
      case "Bash": {
        const cmd = (input.command as string) || "";
        const display = cmd.length > 120 ? cmd.slice(0, 117) + "..." : cmd;
        return `\n\n**Running command**\n\`\`\`bash\n${display}\n\`\`\`\n\n`;
      }
      case "Grep":
        return `\n\n**Searching** for \`${input.pattern}\`${input.path ? ` in \`${input.path}\`` : ""}\n\n`;
      case "Glob":
        return `\n\n**Finding files** matching \`${input.pattern}\`\n\n`;
      case "WebFetch":
        return `\n\n**Fetching** \`${input.url}\`\n\n`;
      case "WebSearch":
        return `\n\n**Searching web** for "${input.query}"\n\n`;
      case "Task":
        return `\n\n**Launching agent** ${input.description || ""}\n\n`;
      case "TodoWrite":
        return ""; // silent — not useful to show
      default:
        return `\n\n**${name}**\n\n`;
    }
  } catch {
    return `\n\n**${name}**\n\n`;
  }
}

/**
 * Format a tool result summary. Truncates long output to keep
 * the chat readable, and wraps multi-line output in a code block.
 */
function formatToolSummary(summary: string): string {
  if (!summary) return "";
  const MAX = 600;
  const trimmed = summary.length > MAX
    ? summary.slice(0, MAX) + "\n...(truncated)"
    : summary;
  // Multi-line summaries get a fenced block; single-line stays inline.
  if (trimmed.includes("\n")) {
    return `\n<details>\n<summary>Result</summary>\n\n\`\`\`\n${trimmed}\n\`\`\`\n</details>\n\n`;
  }
  return `\n> ${trimmed}\n\n`;
}

/**
 * Streaming: run query, call onDelta for each text chunk, then return full text.
 * This keeps the generator iteration in the same async context as query()
 * creation, which avoids a timing race in the SDK subprocess lifecycle.
 */
export async function createStreamingCompletion(
  messages: Message[],
  model?: string,
  onDelta?: (text: string) => void,
): Promise<string> {
  const { systemPrompt, prompt } = messagesToPrompt(messages);
  const opts = {
    ...baseOptions(systemPrompt, model),
    includePartialMessages: true,
  };
  process.stderr.write(`[claude-sdk] Streaming query: "${prompt.slice(0, 80)}..."\n`);

  // Accumulate tool_use content blocks from stream events so we can
  // produce rich announcements with file paths, commands, etc.
  const pendingTools = new Map<number, { name: string; inputJson: string }>();
  // Track tool_use_ids that already got an announcement via stream events
  // so tool_progress doesn't duplicate them.
  const announcedTools = new Set<string>();

  return runQuery(prompt, opts, (message) => {
    if (!onDelta) return;

    if (message.type === "stream_event") {
      const event = message.event as Record<string, unknown>;

      // --- text deltas: stream straight through ---
      if (event.type === "content_block_delta") {
        const delta = event.delta as Record<string, unknown>;
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          onDelta(delta.text);
        }
        // Accumulate tool input JSON fragments
        if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          const idx = event.index as number;
          const tc = pendingTools.get(idx);
          if (tc) tc.inputJson += delta.partial_json;
        }
      }

      // --- tool_use block start: register it ---
      if (event.type === "content_block_start") {
        const block = event.content_block as Record<string, unknown>;
        if (block?.type === "tool_use") {
          const idx = event.index as number;
          pendingTools.set(idx, { name: block.name as string, inputJson: "" });
          // Mark the tool_use_id so tool_progress won't duplicate
          if (typeof block.id === "string") announcedTools.add(block.id);
        }
      }

      // --- tool_use block stop: emit rich announcement ---
      if (event.type === "content_block_stop") {
        const idx = event.index as number;
        const tc = pendingTools.get(idx);
        if (tc) {
          const formatted = formatToolAnnouncement(tc.name, tc.inputJson);
          if (formatted) onDelta(formatted);
          pendingTools.delete(idx);
        }
      }
    }

    // Fallback: if a tool wasn't announced via stream events (e.g. when
    // includePartialMessages misses it), show a simple progress line.
    if (message.type === "tool_progress") {
      const prog = message as Record<string, unknown>;
      const toolId = prog.tool_use_id as string;
      const toolName = prog.tool_name as string;
      if (toolName && toolId && !announcedTools.has(toolId)) {
        announcedTools.add(toolId);
        onDelta(`\n\n**${toolName}** ...\n\n`);
      }
    }

    // Tool result summaries — formatted and optionally truncated
    if (message.type === "tool_use_summary") {
      const summary = (message as Record<string, unknown>).summary as string;
      if (summary) {
        onDelta(formatToolSummary(summary));
      }
    }
  });
}
