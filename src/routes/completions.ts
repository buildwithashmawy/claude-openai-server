import { Router, Request, Response } from "express";
import { runClaude, extractResponseText } from "../services/claude-runner";
import { buildChatCompletion, buildChunk, buildError, generateChatId } from "../utils/openai-format";
import { initSSE, sendSSE, endSSE, splitIntoTokens } from "../utils/sse";

const REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT || "300000", 10);

const router = Router();

interface Message {
  role: string;
  content: string;
}

function buildPrompt(messages: Message[]): string {
  return messages
    .map((m) => {
      const role = m.role.charAt(0).toUpperCase() + m.role.slice(1);
      return `${role}: ${m.content}`;
    })
    .join("\n");
}

router.post("/v1/chat/completions", async (req: Request, res: Response) => {
  const { messages, stream, model } = req.body;
  const modelName = model || "gpt-4o";

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    res.status(400).json(buildError("messages array is required and must not be empty", "invalid_request"));
    return;
  }

  const workingDirectory = (req.headers["x-working-directory"] as string) || process.cwd();
  const prompt = buildPrompt(messages);

  const claude = runClaude(prompt, workingDirectory);
  let finished = false;

  // Handle request cancellation
  const onClose = () => {
    if (!finished) {
      claude.process.kill("SIGTERM");
    }
  };
  req.on("close", onClose);

  // Set up timeout
  const timeout = setTimeout(() => {
    if (!finished) {
      claude.process.kill("SIGTERM");
      if (!res.headersSent) {
        res.status(504).json(buildError("Request timed out", "timeout"));
      }
    }
  }, REQUEST_TIMEOUT);

  try {
    const result = await claude.result;
    finished = true;
    clearTimeout(timeout);

    if (result.exitCode !== 0) {
      const errMsg = `Claude Code process exited with code ${result.exitCode}: ${result.stderr.trim()}`;
      if (!res.headersSent) {
        res.status(500).json(buildError(errMsg));
      }
      return;
    }

    const responseText = extractResponseText(result.stdout);

    if (stream) {
      initSSE(res);

      const chatId = generateChatId();
      const tokens = splitIntoTokens(responseText);

      // Send initial chunk with role
      sendSSE(res, buildChunk(chatId, "", null, "assistant", modelName));

      // Stream content in token-sized chunks
      for (const token of tokens) {
        sendSSE(res, buildChunk(chatId, token, null, undefined, modelName));
      }

      // Send final chunk with finish_reason
      sendSSE(res, buildChunk(chatId, undefined, "stop", undefined, modelName));

      endSSE(res);
    } else {
      res.json(buildChatCompletion(responseText, modelName));
    }
  } catch (err) {
    finished = true;
    clearTimeout(timeout);
    const message = err instanceof Error ? err.message : String(err);
    if (!res.headersSent) {
      res.status(500).json(buildError(message));
    }
  }
});

export default router;
