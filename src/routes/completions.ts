import { Router, Request, Response } from "express";
import { createCompletion, createStreamingCompletion, Message } from "../services/claude-client";
import { buildChatCompletion, buildChunk, buildError, generateChatId } from "../utils/openai-format";
import { initSSE, sendSSE, endSSE } from "../utils/sse";

const router = Router();

router.post("/v1/chat/completions", async (req: Request, res: Response) => {
  const { messages, stream, model } = req.body;

  process.stderr.write(
    `[req] model=${model ?? "(default)"} stream=${!!stream} messages=${messages?.length ?? 0}\n`
  );

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

      let streamedText = false;

      const resultText = await createStreamingCompletion(
        messages as Message[],
        model,
        (delta) => {
          if (!res.writableEnded) {
            sendSSE(res, buildChunk(chatId, delta, null, undefined, model));
            streamedText = true;
          }
        },
      );

      if (!res.writableEnded) {
        // If no stream_event deltas fired, send result as a single chunk
        if (!streamedText && resultText) {
          sendSSE(res, buildChunk(chatId, resultText, null, undefined, model));
        }
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
    const errMsg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[claude-client] Error: ${errMsg}\n`);
    if (!res.headersSent) {
      res.status(500).json(buildError(errMsg));
    } else if (!res.writableEnded) {
      endSSE(res);
    }
  }
});

export default router;
