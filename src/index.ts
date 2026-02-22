#!/usr/bin/env node

import express from "express";
import cors from "cors";
import completionsRouter from "./routes/completions";
import modelsRouter from "./routes/models";

const PORT = parseInt(process.env.PORT || "3456", 10);
const HOST = process.env.HOST || "127.0.0.1";

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = ((Date.now() - start) / 1000).toFixed(1);
    const time = new Date().toTimeString().slice(0, 8);
    process.stderr.write(`[${time}] ${req.method} ${req.path} — ${res.statusCode} — ${duration}s\n`);
  });
  next();
});

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Routes
app.use(completionsRouter);
app.use(modelsRouter);

app.listen(PORT, HOST, () => {
  console.log(`Claude Code OpenAI Proxy listening on http://${HOST}:${PORT}`);
  console.log(`Endpoints:`);
  console.log(`  POST http://${HOST}:${PORT}/v1/chat/completions`);
  console.log(`  GET  http://${HOST}:${PORT}/v1/models`);
  console.log(`  GET  http://${HOST}:${PORT}/health`);
});
