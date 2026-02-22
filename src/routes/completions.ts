import { Router, Request, Response } from "express";
import { createCompletion, createStreamingCompletion, Message } from "../services/claude-client";
import { buildChatCompletion, buildChunk, buildError, generateChatId } from "../utils/openai-format";
import { initSSE, sendSSE, endSSE } from "../utils/sse";

const router = Router();

const REQUEST_TIMEOUT_MS = 120_000; // 2 minutes

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

      const { stream: sdkStream, close } = createStreamingCompletion(
        messages as Message[],
        model
      );

      let aborted = false;
      const abort = () => {
        if (!aborted) {
          aborted = true;
          close();
        }
      };

      req.on("close", abort);

      // Timeout to avoid infinite hang if SDK never responds
      const timeout = setTimeout(() => {
        process.stderr.write("[stream] Request timed out waiting for SDK\n");
        abort();
        if (!res.writableEnded) {
          sendSSE(res, buildChunk(chatId, "Error: request timed out waiting for Claude Code SDK", null, undefined, model));
          sendSSE(res, buildChunk(chatId, undefined, "stop", undefined, model));
          endSSE(res);
        }
      }, REQUEST_TIMEOUT_MS);

      let streamedText = false;
      let fallbackText = "";

      for await (const message of sdkStream) {
        if (aborted) break;

        const subtype = ("subtype" in message) ? `.${message.subtype}` : "";
        process.stderr.write(`[stream] msg: ${message.type}${subtype}\n`);

        // Log auth issues
        if (message.type === "auth_status") {
          const auth = message as { isAuthenticating: boolean; error?: string; output: string[] };
          process.stderr.write(`[stream] auth: authenticating=${auth.isAuthenticating} error=${auth.error ?? "none"}\n`);
          if (auth.error) {
            sendSSE(res, buildChunk(chatId, `Auth error: ${auth.error}`, null, undefined, model));
            streamedText = true;
          }
        }

        // Log init message for debugging
        if (message.type === "system" && "subtype" in message && message.subtype === "init") {
          const init = message as Record<string, unknown>;
          process.stderr.write(`[stream] init: model=${init.model} tools=${(init.tools as string[])?.length ?? 0}\n`);
        }

        // Stream text deltas from partial assistant messages (real-time streaming)
        if (message.type === "stream_event") {
          const event = message.event as Record<string, unknown>;
          if (event.type === "content_block_delta") {
            const delta = event.delta as Record<string, unknown>;
            if (delta.type === "text_delta" && typeof delta.text === "string") {
              sendSSE(res, buildChunk(chatId, delta.text, null, undefined, model));
              streamedText = true;
            }
          }
        }

        // Capture result text as fallback (in case stream_event didn't fire)
        if (message.type === "result") {
          if (message.subtype === "success") {
            fallbackText = (message as { result: string }).result;
          } else {
            const errors = (message as { errors?: string[] }).errors;
            const errMsg = errors?.join("; ") || "Claude Code query failed";
            process.stderr.write(`[stream] SDK error result: ${errMsg}\n`);
            if (!streamedText) {
              sendSSE(res, buildChunk(chatId, `Error: ${errMsg}`, null, undefined, model));
              streamedText = true;
            }
          }
        }
      }

      clearTimeout(timeout);

      if (!aborted && !res.writableEnded) {
        if (!streamedText && fallbackText) {
          sendSSE(res, buildChunk(chatId, fallbackText, null, undefined, model));
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
