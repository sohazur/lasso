import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { triggerCall } from "../agents/orchestrator.js";

const CheckoutEventBody = z.object({
  merchant_id: z.string().min(1),
  trigger: z.string(),
  snapshot: z.object({
    phone: z.string().optional(),
    email: z.string().optional(),
    name: z.string().optional(),
    street_address: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    postal_code: z.string().optional(),
    country: z.string().optional(),
    cart_lines: z
      .array(
        z.object({
          title: z.string().optional(),
          qty: z.number().optional(),
          price_cents: z.number().optional(),
        })
      )
      .optional(),
    cart_total_cents: z.number().optional(),
    store_url: z.string().optional(),
    store_name: z.string().optional(),
    detected_platform: z.string().nullable().optional(),
    page_entered_at: z.number().optional(),
  }),
  page_url: z.string().optional(),
  user_agent: z.string().optional(),
  fired_at: z.number().optional(),
});

export async function registerCheckoutEventRoute(app: FastifyInstance): Promise<void> {
  app.post("/checkout-event", async (req, reply) => {
    const parsed = CheckoutEventBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });
    }

    // Reply fast — sendBeacon doesn't wait for the response, and we don't want
    // to hold the connection while we spin up the call.
    reply.code(202).send({ accepted: true });

    // Fire the call pipeline in the background
    triggerCall(parsed.data)
      .then((result) => {
        if (!result.call_id) {
          console.warn(`[lasso] /checkout-event: not placing call — ${result.reason}`);
        } else {
          console.log(`[lasso] /checkout-event: call placed (call_id=${result.call_id})`);
        }
      })
      .catch((err) => {
        console.error("[lasso] /checkout-event: orchestrator threw", err);
      });
  });
}
