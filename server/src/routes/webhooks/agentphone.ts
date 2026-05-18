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
import { getStore, type CallStatus, type CallOutcome, type CallRow } from "../../clients/supabase.js";
import { getMemory } from "../../clients/supermemory.js";

/**
 * Call-end webhook. AgentPhone POSTs here when a call ends.
 *
 * AgentPhone's exact payload shape isn't fully documented for us and
 * may drift across SDK versions. Rather than reject with 400 (which
 * would leave the row stuck at `ringing` forever — the very symptom
 * that prompted this rewrite), we accept any JSON object, log the raw
 * body for forensics, and heuristically pluck:
 *   - the AgentPhone call id (so we can find our row via agentphone_call_id)
 *   - a status / call-state field
 *   - duration in seconds
 *   - the transcript (if present)
 */
type LooseEv = Record<string, unknown>;

const STATUS_MAP: Record<string, CallStatus> = {
  initiated: "ringing",
  ringing: "ringing",
  in_progress: "connected",
  "in-progress": "connected",
  connected: "connected",
  answered: "connected",
  completed: "completed",
  ended: "completed",
  finished: "completed",
  hangup: "completed",
  failed: "failed",
  busy: "no_answer",
  no_answer: "no_answer",
  "no-answer": "no_answer",
  cancelled: "failed",
  canceled: "failed",
};

function pick<T>(obj: LooseEv, ...keys: string[]): T | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null) return v as T;
  }
  for (const nestedKey of ["data", "call", "payload", "event"]) {
    const nested = obj[nestedKey];
    if (nested && typeof nested === "object") {
      const v = pick<T>(nested as LooseEv, ...keys);
      if (v !== undefined) return v;
    }
  }
  return undefined;
}

function extractTranscript(obj: LooseEv): string | undefined {
  const direct = pick<string>(obj, "transcript", "transcription", "transcript_text");
  if (typeof direct === "string" && direct.length > 0) return direct;
  const turns = pick<Array<{ speaker?: string; role?: string; text?: string; content?: string }>>(
    obj,
    "turns",
    "messages",
    "history",
    "recentHistory",
  );
  if (Array.isArray(turns) && turns.length > 0) {
    return turns
      .map((t) => {
        const who = (t.speaker ?? t.role ?? "").toString().toLowerCase();
        const label =
          who.includes("agent") || who === "assistant" || who === "outbound" ? "Agent" : "Customer";
        const text = t.text ?? t.content ?? "";
        return text ? `${label}: ${text}` : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return undefined;
}

export async function registerAgentPhoneWebhook(app: FastifyInstance): Promise<void> {
  app.post("/webhooks/agentphone", async (req, reply) => {
    const ev = (req.body ?? {}) as LooseEv;
    console.log(
      `[lasso] agentphone webhook: keys=${Object.keys(ev).join(",")} raw=${JSON.stringify(ev).slice(0, 600)}`,
    );

    const agentphoneCallId =
      pick<string>(ev, "call_id", "callId", "id", "conversationId") ?? null;
    const rawStatus = pick<string>(ev, "status", "state", "event", "type") ?? "";
    const status = STATUS_MAP[rawStatus.toLowerCase()] ?? null;
    const durationSecs = pick<number>(ev, "duration_secs", "durationSecs", "duration");
    const outcome = pick<string>(ev, "outcome");
    const transcript = extractTranscript(ev);
    const metadataCallRowId =
      typeof ev.metadata === "object" && ev.metadata
        ? (ev.metadata as LooseEv)["call_row_id"]
        : undefined;

    const db = getStore();
    let call: CallRow | null = null;
    if (typeof metadataCallRowId === "string") {
      call = await db.getCall(metadataCallRowId);
    }
    if (!call && agentphoneCallId) {
      const recent = await db.listCalls(undefined, 50);
      call =
        recent.find(
          (c) =>
            c.agentphone_call_id === agentphoneCallId ||
            c.id === agentphoneCallId,
        ) ?? null;
    }
    if (!call) {
      const recent = await db.listCalls(undefined, 5);
      call =
        recent.find(
          (c) =>
            c.status === "ringing" || c.status === "connected" || c.status === "preparing",
        ) ?? null;
      if (call) {
        console.warn(
          `[lasso] agentphone webhook: no id-match — falling back to most recent active call ${call.id}`,
        );
      }
    }
    if (!call) {
      console.warn(
        `[lasso] agentphone webhook: no matching call row (agentphoneCallId=${agentphoneCallId})`,
      );
      return reply.send({ ok: false, reason: "no_matching_call" });
    }

    const patch: Parameters<typeof db.updateCall>[1] = {};
    if (status) patch.status = status;
    if (typeof durationSecs === "number") patch.duration_secs = durationSecs;
    if (transcript) patch.transcript = transcript;
    if (outcome) {
      const validOutcomes: CallOutcome[] = ["recovered", "declined", "unreachable", "error"];
      if ((validOutcomes as string[]).includes(outcome)) {
        patch.outcome = outcome as CallOutcome;
      }
    }
    if (status === "completed" || status === "failed" || status === "no_answer") {
      patch.ended_at = new Date().toISOString();
    }

    if (Object.keys(patch).length === 0) {
      console.warn(
        `[lasso] agentphone webhook: nothing actionable in payload (raw status=${rawStatus})`,
      );
      return reply.send({ ok: true, applied: false });
    }

    await db.updateCall(call.id, patch);
    console.log(
      `[lasso] agentphone webhook: applied patch to call ${call.id} → ${JSON.stringify(patch).slice(0, 200)}`,
    );

    if (status === "completed" && transcript) {
      const tag = `merchant:${call.merchant_id}:phone:${normalize(call.phone)}`;
      try {
        await getMemory().store(tag, {
          text: transcript,
          metadata: {
            call_id: call.id,
            outcome: outcome ?? "unknown",
            duration_secs: durationSecs ?? null,
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
  return s.replace(/\D/g, "");
}
