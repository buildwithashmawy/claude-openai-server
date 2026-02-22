import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

export const DEFAULT_MODEL = "claude-sonnet-4-20250514";
const DEFAULT_MAX_TOKENS = 8192;

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string;
}

function resolveModel(model?: string): string {
  if (!model) return DEFAULT_MODEL;
  // Pass through any claude model name directly
  if (model.startsWith("claude-")) return model;
  // Map common aliases
  if (model === "gpt-4" || model === "gpt-4o") return "claude-sonnet-4-20250514";
  if (model === "gpt-3.5-turbo") return "claude-haiku-4-5-20251001";
  return DEFAULT_MODEL;
}

function separateSystemAndMessages(messages: Message[]): {
  system: string | undefined;
  messages: AnthropicMessage[];
} {
  let system: string | undefined;
  const anthropicMessages: AnthropicMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      // Concatenate multiple system messages
      system = system ? `${system}\n\n${msg.content}` : msg.content;
    } else {
      anthropicMessages.push({
        role: msg.role as "user" | "assistant",
        content: msg.content,
      });
    }
  }

  // Anthropic requires at least one message and it must start with "user"
  // If first message is assistant, prepend an empty user turn
  if (anthropicMessages.length > 0 && anthropicMessages[0].role === "assistant") {
    anthropicMessages.unshift({ role: "user", content: "Continue." });
  }

  // If no messages remain, add a default
  if (anthropicMessages.length === 0) {
    anthropicMessages.push({ role: "user", content: system || "Hello" });
    system = undefined;
  }

  return { system, messages: anthropicMessages };
}

export async function createCompletion(
  messages: Message[],
  model?: string,
  maxTokens?: number
): Promise<string> {
  const resolved = separateSystemAndMessages(messages);
  const response = await client.messages.create({
    model: resolveModel(model),
    max_tokens: maxTokens || DEFAULT_MAX_TOKENS,
    system: resolved.system,
    messages: resolved.messages,
  });

  return response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

export function createStreamingCompletion(
  messages: Message[],
  model?: string,
  maxTokens?: number
) {
  const resolved = separateSystemAndMessages(messages);
  return client.messages.stream({
    model: resolveModel(model),
    max_tokens: maxTokens || DEFAULT_MAX_TOKENS,
    system: resolved.system,
    messages: resolved.messages,
  });
}
