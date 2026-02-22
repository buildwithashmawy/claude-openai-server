import { query, type SDKMessage, type Options } from "@anthropic-ai/claude-agent-sdk";

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
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
 * Convert OpenAI-style messages to a single prompt string.
 * System messages become a preamble, user/assistant messages
 * form the conversation.
 */
function messagesToPrompt(messages: Message[]): {
  systemPrompt: string | undefined;
  prompt: string;
} {
  let systemPrompt: string | undefined;
  const turns: string[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      systemPrompt = systemPrompt
        ? `${systemPrompt}\n\n${msg.content}`
        : msg.content;
    } else if (msg.role === "user") {
      turns.push(`Human: ${msg.content}`);
    } else if (msg.role === "assistant") {
      turns.push(`Assistant: ${msg.content}`);
    }
  }

  // If only system messages, use them as the prompt
  const prompt = turns.length > 0 ? turns.join("\n\n") : systemPrompt || "Hello";
  if (turns.length > 0) {
    return { systemPrompt, prompt };
  }
  return { systemPrompt: undefined, prompt };
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
  const q = query({
    prompt,
    options: baseOptions(systemPrompt, model),
  });

  let resultText = "";

  for await (const message of q) {
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
  const q = query({
    prompt,
    options: {
      ...baseOptions(systemPrompt, model),
      includePartialMessages: true,
    },
  });

  return { stream: q, close: () => q.close() };
}
