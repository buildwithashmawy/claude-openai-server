import { Router, Request, Response } from "express";
import { createCompletion, createStreamingCompletion, Message } from "../services/claude-client";
import { buildChatCompletion, buildChunk, buildError, generateChatId } from "../utils/openai-format";
import { initSSE, sendSSE, endSSE } from "../utils/sse";

const router = Router();

router.post("/v1/chat/completions", async (req: Request, res: Response) => {
  const { messages, stream, model } = req.body;

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

      const { stream: sdkStream, close } = createStreamingCompletion(
        messages as Message[],
        model
      );

      let aborted = false;
      req.on("close", () => {
        aborted = true;
        close();
      });

      for await (const message of sdkStream) {
        if (aborted) break;

        // Stream text deltas from partial assistant messages
        if (message.type === "stream_event") {
          const event = message.event as Record<string, unknown>;
          if (event.type === "content_block_delta") {
            const delta = event.delta as Record<string, unknown>;
            if (delta.type === "text_delta" && typeof delta.text === "string") {
              sendSSE(res, buildChunk(chatId, delta.text, null, undefined, model));
            }
          }
        }
      }

      if (!aborted) {
        sendSSE(res, buildChunk(chatId, undefined, "stop", undefined, model));
        endSSE(res);
      }
    } else {
      const responseText = await createCompletion(
        messages as Message[],
        model
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
