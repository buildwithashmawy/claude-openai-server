# claude-code-openai-proxy

A local OpenAI-compatible API server that proxies requests to Claude Code CLI. Connect Cursor (or any OpenAI-compatible client) to Claude Code by pointing it at this server — no API key needed, just a working Claude Code CLI installation with a Claude Max subscription or API key configured.

## Install and Build

```bash
git clone <repo>
cd claude-code-openai-proxy
npm install
npm run build
```

## Run the Server

```bash
node dist/index.js
# or
npx claude-code-openai-proxy
```

The server starts on `http://127.0.0.1:3456` by default.

## Configure Cursor

1. Go to **Cursor Settings > Models > Override OpenAI Base URL**
2. Set the base URL to `http://localhost:3456/v1`
3. Set any string as the API key (e.g., `sk-not-needed`) — it's ignored
4. Select `gpt-4o` as the model (the proxy advertises itself as `gpt-4o` so Cursor accepts it, but all requests are routed to Claude Code)

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3456` | Port the server listens on |
| `HOST` | `127.0.0.1` | Bind address (localhost only for security) |
| `CLAUDE_CODE_PATH` | `claude` | Path to the Claude Code CLI binary |
| `REQUEST_TIMEOUT` | `300000` | Request timeout in milliseconds (default 5 min) |

## How It Works

```
Cursor / Any OpenAI Client
    │
    │  POST /v1/chat/completions
    │  Authorization: Bearer <ignored>
    │
    ▼
Local Proxy Server (localhost:3456)
    │
    │  Extracts messages → builds prompt
    │  Spawns: claude -p "<prompt>" --output-format json --verbose
    │
    ▼
Claude Code CLI (uses your Claude Max subscription or API key)
    │
    ▼
Response translated back → OpenAI chat completion JSON format
```

The server receives OpenAI-formatted chat completion requests, converts the message array into a single prompt, spawns the Claude Code CLI as a subprocess, and translates the output back into OpenAI's response format. Both streaming (SSE) and non-streaming responses are supported.

## API Endpoints

- **POST /v1/chat/completions** — Main chat completion endpoint (streaming and non-streaming)
- **GET /v1/models** — Returns available models (advertises as `gpt-4o` for client compatibility)
- **GET /health** — Health check
