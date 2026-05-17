/**
 * AgentPhone webhook receiver. Called by AgentPhone when a call transitions
 * through ringing → answered → completed (or fails).
 *
 * Payload shape is a placeholder — patch when we have real AgentPhone docs.
 * The behavior is correct either way:
 *   - update call row status + duration + transcript
 *   - on completion, write distilled facts to Supermemory under the per-phone tag
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getStore, type CallStatus, type CallOutcome } from "../../clients/supabase.js";
import { getMemory } from "../../clients/supermemory.js";

const WebhookBody = z.object({
  call_id: z.string(),
  status: z.enum(["ringing", "connected", "completed", "failed", "no_answer"]),
  outcome: z.enum(["recovered", "declined", "unreachable", "error"]).optional(),
  duration_secs: z.number().optional(),
  transcript: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export async function registerAgentPhoneWebhook(app: FastifyInstance): Promise<void> {
  app.post("/webhooks/agentphone", async (req, reply) => {
    const parsed = WebhookBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });
    }
    const ev = parsed.data;

    const callRowId = (ev.metadata?.call_row_id as string | undefined) ?? ev.call_id;
    const db = getStore();
    const call = await db.getCall(callRowId);
    if (!call) {
      console.warn(`[lasso] agentphone webhook: call_row_id=${callRowId} not found`);
      return reply.code(404).send({ error: "call_not_found" });
    }

    const patch: Parameters<typeof db.updateCall>[1] = {
      status: ev.status as CallStatus,
      outcome: (ev.outcome as CallOutcome) ?? call.outcome ?? null,
      duration_secs: ev.duration_secs ?? call.duration_secs ?? null,
      transcript: ev.transcript ?? call.transcript ?? null,
    };
    if (ev.status === "completed" || ev.status === "failed" || ev.status === "no_answer") {
      patch.ended_at = new Date().toISOString();
    }
    await db.updateCall(call.id, patch);

    // On completion, write the transcript to Supermemory under the per-caller tag.
    // Fact extraction can be added later; for now, raw transcript + outcome is enough.
    if (ev.status === "completed" && ev.transcript) {
      const tag = `merchant:${call.merchant_id}:phone:${normalize(call.phone)}`;
      try {
        await getMemory().store(tag, {
          text: ev.transcript,
          metadata: {
            call_id: call.id,
            outcome: ev.outcome ?? "unknown",
            duration_secs: ev.duration_secs ?? null,
            ended_at: new Date().toISOString(),
            cart_total_cents: call.cart_total_cents ?? null,
          },
        });
      } catch (err) {
        console.warn("[lasso] failed to persist transcript to supermemory", err);
      }
    }

    return reply.send({ ok: true });
  });
}

function normalize(s: string): string {
  return s.replace(/[^\d+]/g, "");
}
