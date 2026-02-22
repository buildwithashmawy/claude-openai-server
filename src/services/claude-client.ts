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
    // Omit `tools` — let the CLI use its full default toolset.
    // Omit `permissionMode` — let the CLI use its default; permission
    // prompts are routed through canUseTool via --permission-prompt-tool stdio.
    env: cleanEnv(),
    persistSession: false,
    settingSources: [],
    // Auto-approve all tool calls. This avoids bypassPermissions
    // (which the CLI rejects under root/sudo) while still allowing
    // full agent capabilities including Read, Write, Bash, etc.
    canUseTool: async (toolName, input) => {
      process.stderr.write(`[claude-sdk] tool-approve: ${toolName}\n`);
      return { behavior: "allow" as const };
    },
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

  return runQuery(prompt, opts, (message) => {
    if (message.type === "stream_event" && onDelta) {
      const event = message.event as Record<string, unknown>;
      if (event.type === "content_block_delta") {
        const delta = event.delta as Record<string, unknown>;
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          onDelta(delta.text);
        }
      }
    }
  });
}
