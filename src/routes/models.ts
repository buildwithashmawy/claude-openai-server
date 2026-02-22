import { Router, Request, Response } from "express";

const router = Router();

router.get("/v1/models", (_req: Request, res: Response) => {
  res.json({
    object: "list",
    data: [
      {
        id: "claude-code",
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "anthropic",
      },
    ],
  });
});

export default router;
