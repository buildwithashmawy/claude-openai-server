import { spawn, ChildProcess } from "child_process";

const CLAUDE_CODE_PATH = process.env.CLAUDE_CODE_PATH || "claude";

export interface ClaudeResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ClaudeProcess {
  process: ChildProcess;
  result: Promise<ClaudeResult>;
}

export function runClaude(prompt: string, workingDirectory: string): ClaudeProcess {
  const args = ["-p", prompt, "--output-format", "json", "--verbose"];

  // Strip CLAUDECODE env var to avoid "nested session" detection
  const env = { ...process.env };
  delete env.CLAUDECODE;

  const child = spawn(CLAUDE_CODE_PATH, args, {
    cwd: workingDirectory,
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });

  const result = new Promise<ClaudeResult>((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout!.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });

    child.stderr!.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    child.on("error", (err) => {
      reject(new Error(`Failed to spawn Claude Code: ${err.message}`));
    });

    child.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        exitCode: code ?? 1,
      });
    });
  });

  return { process: child, result };
}

export function extractResponseText(stdout: string): string {
  try {
    const parsed = JSON.parse(stdout);

    // Claude Code JSON output may have a "result" field or be a direct message
    if (typeof parsed === "string") {
      return parsed;
    }

    if (parsed.result) {
      return typeof parsed.result === "string" ? parsed.result : JSON.stringify(parsed.result);
    }

    if (parsed.content) {
      return typeof parsed.content === "string" ? parsed.content : JSON.stringify(parsed.content);
    }

    // If it's an array of content blocks, extract text
    if (Array.isArray(parsed)) {
      const textBlocks = parsed
        .filter((block: { type: string }) => block.type === "text")
        .map((block: { text: string }) => block.text);
      if (textBlocks.length > 0) {
        return textBlocks.join("\n");
      }
    }

    return stdout.trim();
  } catch {
    // If JSON parsing fails, return raw stdout
    return stdout.trim();
  }
}
