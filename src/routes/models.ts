import { Router, Request, Response } from "express";

const router = Router();

router.get("/v1/models", (_req: Request, res: Response) => {
  res.json({
    object: "list",
    data: [
      {
        id: "gpt-4o",
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "claude-code-proxy",
      },
    ],
  });
});

export default router;
