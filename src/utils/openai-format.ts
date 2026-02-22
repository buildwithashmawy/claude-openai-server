import { randomUUID } from "crypto";

export interface OpenAIChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: {
    index: number;
    message: {
      role: "assistant";
      content: string;
    };
    finish_reason: "stop";
  }[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface OpenAIChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: {
    index: number;
    delta: { role?: "assistant"; content?: string };
    finish_reason: null | "stop";
  }[];
}

export interface OpenAIErrorResponse {
  error: {
    message: string;
    type: string;
    code: string;
  };
}

export function generateChatId(): string {
  return `chatcmpl-${randomUUID()}`;
}

export function buildChatCompletion(content: string, model = "claude-sonnet-4-20250514"): OpenAIChatCompletionResponse {
  return {
    id: generateChatId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}

export function buildChunk(
  id: string,
  content: string | undefined,
  finishReason: null | "stop",
  role?: "assistant",
  model = "claude-sonnet-4-20250514"
): OpenAIChatCompletionChunk {
  const delta: { role?: "assistant"; content?: string } = {};
  if (role) delta.role = role;
  if (content !== undefined) delta.content = content;

  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
      },
    ],
  };
}

export function buildError(message: string, code: string = "claude_code_error"): OpenAIErrorResponse {
  return {
    error: {
      message,
      type: "server_error",
      code,
    },
  };
}
