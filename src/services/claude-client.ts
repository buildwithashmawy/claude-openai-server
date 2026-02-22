import { query, type SDKMessage, type Options } from "@anthropic-ai/claude-agent-sdk";

export interface Message {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
}

interface ContentPart {
  type: string;
  text?: string;
}

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

function baseOptions(
  systemPrompt: string | undefined,
  model?: string
): Options {
  const opts: Options = {
    maxTurns: 1,
    tools: [],
    env: cleanEnv(),
    persistSession: false,
    settingSources: [],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    stderr: (data: string) => {
      process.stderr.write(`[claude-sdk] ${data}`);
    },
  };

  if (systemPrompt) {
    opts.systemPrompt = systemPrompt;
  }

  if (model) {
    opts.model = model;
  }

  return opts;
}

/**
 * Non-streaming: run query and return the final result text.
 */
export async function createCompletion(
  messages: Message[],
  model?: string
): Promise<string> {
  const { systemPrompt, prompt } = messagesToPrompt(messages);
  process.stderr.write(`[claude-sdk] Non-streaming query: "${prompt.slice(0, 80)}..."\n`);

  const q = query({
    prompt,
    options: baseOptions(systemPrompt, model),
  });

  let resultText = "";

  for await (const message of q) {
    process.stderr.write(`[claude-sdk] msg: ${message.type}${("subtype" in message) ? `.${message.subtype}` : ""}\n`);

    if (message.type === "result" && message.subtype === "success") {
      resultText = message.result;
    }
  }

  return resultText;
}

/**
 * Streaming: returns the async generator of SDK messages.
 * Caller iterates to get stream_event messages with text deltas.
 */
export function createStreamingCompletion(
  messages: Message[],
  model?: string
): { stream: AsyncGenerator<SDKMessage, void>; close: () => void } {
  const { systemPrompt, prompt } = messagesToPrompt(messages);
  process.stderr.write(`[claude-sdk] Streaming query: "${prompt.slice(0, 80)}..."\n`);

  const q = query({
    prompt,
    options: {
      ...baseOptions(systemPrompt, model),
      includePartialMessages: true,
    },
  });

  return { stream: q, close: () => q.close() };
}
