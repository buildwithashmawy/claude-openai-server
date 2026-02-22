import { Router, Request, Response } from "express";

const router = Router();

const MODELS = [
  { id: "claude-opus-4-20250514", name: "Claude Opus 4" },
  { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4" },
  { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5" },
];

router.get("/v1/models", (_req: Request, res: Response) => {
  res.json({
    object: "list",
    data: MODELS.map((m) => ({
      id: m.id,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: "anthropic",
    })),
  });
});

export default router;
