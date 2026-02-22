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

Cursor's "Override OpenAI Base URL" routes requests through Cursor's cloud servers, which block connections to `localhost` (SSRF protection). You need to expose the proxy via an HTTPS tunnel.

### Step 1: Start the proxy

```bash
node dist/index.js
```

### Step 2: Create an HTTPS tunnel with ngrok

```bash
ngrok http 3456
```

This gives you a public URL like `https://abc123.ngrok-free.app`.

### Step 3: Configure Cursor

1. Go to **Cursor Settings > Models > Override OpenAI Base URL**
2. Set the base URL to `https://abc123.ngrok-free.app/v1` (your ngrok URL + `/v1`)
3. Set any string as the API key (e.g., `sk-not-needed`) — it's ignored
4. Select `claude-code` as the model

> **Note:** If Cursor rejects the model name `claude-code`, you can use any model name — the proxy ignores the model field and always routes to Claude Code CLI.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3456` | Port the server listens on |
| `HOST` | `0.0.0.0` | Bind address (`0.0.0.0` to allow tunnel access) |
| `CWD` | `process.cwd()` | Working directory for Claude Code (set to your project root) |
| `ADDITIONAL_DIRS` | *(none)* | Comma-separated extra directories Claude can access (e.g. `~/other-project,/tmp`) |
| `MAX_TURNS` | `30` | Maximum agentic turns per request |
| `REQUEST_TIMEOUT` | `300000` | Request timeout in milliseconds (default 5 min) |
| `DEBUG` | *(none)* | Set to `1` for verbose SDK logging |

### Important: Set `CWD` to your workspace

Claude Code resolves file paths relative to `CWD`. If you run the proxy from a different directory than your project, the agent won't be able to read your project files:

```bash
CWD=/path/to/your/project node dist/index.js
```

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
- **GET /v1/models** — Returns available models (single `claude-code` model)
- **GET /health** — Health check
