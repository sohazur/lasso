import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { onboardMerchant, getOnboardStatus } from "../agents/onboarding.js";

const OnboardBody = z.object({
  merchant_id: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/i, "alphanumeric + - _ only"),
  name: z.string().min(1).max(200),
  url: z.string().url(),
  private_context: z.record(z.unknown()).optional(),
});

export async function registerOnboardRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/onboard", async (req, reply) => {
    const parsed = OnboardBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });
    }
    const result = await onboardMerchant(parsed.data);
    return reply.code(202).send(result);
  });

  app.get<{ Params: { id: string } }>("/api/onboard/:id/status", async (req, reply) => {
    const merchant = await getOnboardStatus(req.params.id);
    if (!merchant) return reply.code(404).send({ error: "not_found" });
    return reply.send({
      merchant_id: merchant.id,
      status: merchant.status,
      failed_step: merchant.failed_step ?? null,
      name: merchant.name,
    });
  });
}
