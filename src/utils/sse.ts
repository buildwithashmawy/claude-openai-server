import { Response } from "express";

export function initSSE(res: Response): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
}

export function sendSSE(res: Response, data: unknown): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function endSSE(res: Response): void {
  res.write("data: [DONE]\n\n");
  res.end();
}

export function splitIntoTokens(text: string): string[] {
  // Split by word boundaries, keeping whitespace attached to the following word
  const chunks: string[] = [];
  const words = text.split(/(\s+)/);
  for (const word of words) {
    if (word.length > 0) {
      chunks.push(word);
    }
  }
  return chunks;
}
