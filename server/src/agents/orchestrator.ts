/**
 * Call orchestrator. Called from /checkout-event in the background.
 *
 * Pipeline:
 *   1. Validate merchant onboarded
 *   2. Load brand context + private context + caller history from Supermemory
 *   3. Build the system prompt
 *   4. Place AgentPhone call with lookup_store tool wired to Moss
 *   5. Persist call ID + status transitions in Supabase
 */

import { getStore, type CallRow } from "../clients/supabase.js";
import { getMemory, type MemoryRecord } from "../clients/supermemory.js";
import { getAgentPhone } from "../clients/agentphone.js";
import { getSharedAgent } from "./shared-agent.js";
import { buildSystemPrompt } from "./system-prompt.js";

export type AbandonmentEvent = {
  merchant_id: string;
  trigger: string;
  snapshot: {
    phone?: string;
    email?: string;
    name?: string;
    street_address?: string;
    cart_lines?: Array<{ title?: string; qty?: number; price_cents?: number }>;
    cart_total_cents?: number;
    page_entered_at?: number;
  };
  page_url?: string;
  fired_at?: number;
};

export async function triggerCall(event: AbandonmentEvent): Promise<{ call_id: string | null; reason?: string }> {
  const db = getStore();
  const snap = event.snapshot;

  if (!snap.phone) {
    return { call_id: null, reason: "no_phone" };
  }

  // 1. Verify merchant is onboarded
  const merchant = await db.getMerchant(event.merchant_id);
  if (!merchant) {
    return { call_id: null, reason: "merchant_not_found" };
  }
  if (merchant.status !== "ready") {
    return { call_id: null, reason: `merchant_not_ready:${merchant.status}` };
  }

  // 2. Persist call row
  const callRow = await db.insertCall({
    id: cryptoRandomId(),
    merchant_id: event.merchant_id,
    phone: snap.phone,
    email: snap.email ?? null,
    customer_name: snap.name ?? null,
    page_url: event.page_url ?? null,
    cart_lines: snap.cart_lines ?? [],
    cart_total_cents: snap.cart_total_cents ?? null,
    trigger: event.trigger,
    status: "preparing",
  });

  // 3. Load memory in parallel — best-effort. Memory failures must NOT
  // block the call; the agent works without context (just less informed).
  // Bounded by a 3s timeout so a hung Supermemory call can't strand the
  // row in `preparing` forever.
  const mem = getMemory();
  const phoneTag = `merchant:${event.merchant_id}:phone:${normalizePhone(snap.phone)}`;
  const memoryTimeoutMs = 3000;
  function memGetSafe(tag: string, label: string): Promise<MemoryRecord[]> {
    return Promise.race<MemoryRecord[]>([
      mem.get(tag).catch((err) => {
        console.warn(`[lasso] orchestrator: ${label} read failed (continuing)`, err);
        return [] as MemoryRecord[];
      }),
      new Promise<MemoryRecord[]>((resolve) =>
        setTimeout(() => {
          console.warn(`[lasso] orchestrator: ${label} read timed out after ${memoryTimeoutMs}ms`);
          resolve([]);
        }, memoryTimeoutMs),
      ),
    ]);
  }

  const [brandRecords, privateRecords, callerHistory] = await Promise.all([
    memGetSafe(`merchant:${event.merchant_id}:context`, "brand context"),
    memGetSafe(`merchant:${event.merchant_id}:private`, "private context"),
    memGetSafe(phoneTag, "caller history"),
  ]);

  const brandContext = brandRecords[0] ?? null;
  const privateContext = privateRecords[0] ?? null;

  // Everything after the row insert must either succeed or mark the row
  // `failed` — otherwise an unhandled throw strands it at `preparing`
  // forever with no visible reason.
  try {
    // 4. Build system prompt
    console.log(`[lasso] orchestrator ${callRow.id}: building system prompt`);
    const systemPrompt = buildSystemPrompt({
      storeName: merchant.name,
      customerName: snap.name,
      phone: snap.phone,
      cartLines: snap.cart_lines ?? [],
      cartTotalCents: snap.cart_total_cents,
      checkoutResumeUrl: event.page_url,
      secondsSinceLeft: secondsSince(snap.page_entered_at ?? event.fired_at),
      brandContext,
      privateContext,
      callerHistory,
    });

    // 5. Place the call using the shared Lasso agent + number.
    const shared = getSharedAgent();
    if (!shared) {
      console.error(`[lasso] orchestrator ${callRow.id}: shared agent not initialized`);
      await db.updateCall(callRow.id, { status: "failed", outcome: "error" });
      return { call_id: callRow.id, reason: "shared_agent_not_initialized" };
    }

    console.log(
      `[lasso] orchestrator ${callRow.id}: calling AgentPhone.placeCall to=${snap.phone} agent=${shared.agentId}`,
    );

    // Hard timeout so a hung AgentPhone HTTP request can't strand the row.
    const PLACE_CALL_TIMEOUT_MS = 15_000;
    const placement = await Promise.race([
      getAgentPhone().placeCall({
        agentId: shared.agentId,
        toNumber: snap.phone,
        fromNumberId: shared.numberId ?? undefined,
        systemPrompt,
        initialGreeting: snap.name ? `Hi ${snap.name}, quick call about your checkout — got a sec?` : undefined,
        variables: {
          customer_name: snap.name ?? "there",
          cart_total:
            typeof snap.cart_total_cents === "number"
              ? `$${(snap.cart_total_cents / 100).toFixed(2)}`
              : "",
        },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`placeCall timed out after ${PLACE_CALL_TIMEOUT_MS}ms`)),
          PLACE_CALL_TIMEOUT_MS,
        ),
      ),
    ]);

    console.log(
      `[lasso] orchestrator ${callRow.id}: placement returned status=${placement.status} callId=${placement.callId}`,
    );

    await db.updateCall(callRow.id, {
      agentphone_call_id: placement.callId,
      status: placement.status === "failed" ? "failed" : "ringing",
    });

    return { call_id: callRow.id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[lasso] orchestrator ${callRow.id}: pipeline threw — ${msg}`, err);
    await db.updateCall(callRow.id, {
      status: "failed",
      outcome: "error",
      failed_reason: msg.slice(0, 500),
    });
    return { call_id: callRow.id, reason: msg };
  }
}

function secondsSince(ms?: number): number {
  if (!ms) return 0;
  return Math.max(0, (Date.now() - ms) / 1000);
}

function normalizePhone(s: string): string {
  // For Supermemory tag use — digits only. The tag regex rejects '+'.
  return s.replace(/\D/g, "");
}

function cryptoRandomId(): string {
  // Stable UUID-ish without pulling node:crypto into ESM gotchas
  return ([1e7] + "-" + 1e3 + "-" + 4e3 + "-" + 8e3 + "-" + 1e11).replace(/[018]/g, (c) =>
    (Number(c) ^ (Math.random() * 16 >> (Number(c) / 4))).toString(16)
  );
}
