import { Router, Request, Response } from "express";
import { createCompletion, createStreamingCompletion, Message } from "../services/claude-client";
import { buildChatCompletion, buildChunk, buildError, generateChatId } from "../utils/openai-format";
import { initSSE, sendSSE, endSSE } from "../utils/sse";

const router = Router();

router.post("/v1/chat/completions", async (req: Request, res: Response) => {
  const { messages, stream, model, max_tokens } = req.body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    res.status(400).json(buildError("messages array is required and must not be empty", "invalid_request"));
    return;
  }

  try {
    if (stream) {
      initSSE(res);
      const chatId = generateChatId();

      // Send initial chunk with role
      sendSSE(res, buildChunk(chatId, "", null, "assistant", model));

      const anthropicStream = createStreamingCompletion(
        messages as Message[],
        model,
        max_tokens
      );

      let aborted = false;
      req.on("close", () => {
        aborted = true;
        anthropicStream.abort();
      });

      for await (const event of anthropicStream) {
        if (aborted) break;
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          sendSSE(res, buildChunk(chatId, event.delta.text, null, undefined, model));
        }
      }

      if (!aborted) {
        sendSSE(res, buildChunk(chatId, undefined, "stop", undefined, model));
        endSSE(res);
      }
    } else {
      const responseText = await createCompletion(
        messages as Message[],
        model,
        max_tokens
      );
      res.json(buildChatCompletion(responseText, model));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[claude-client] Error: ${message}\n`);
    if (!res.headersSent) {
      res.status(500).json(buildError(message));
    }
  }
});

export default router;
