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
import { getMemory } from "../clients/supermemory.js";
import { getAgentPhone, type AgentPhoneTool } from "../clients/agentphone.js";
import { env } from "../clients/config.js";
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

  // 3. Load memory in parallel
  const mem = getMemory();
  const phoneTag = `merchant:${event.merchant_id}:phone:${normalizePhone(snap.phone)}`;
  const [brandRecords, privateRecords, callerHistory] = await Promise.all([
    mem.get(`merchant:${event.merchant_id}:context`),
    mem.get(`merchant:${event.merchant_id}:private`),
    mem.get(phoneTag),
  ]);

  const brandContext = brandRecords[0] ?? null;
  const privateContext = privateRecords[0] ?? null;

  // 4. Build system prompt
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

  // 5. Place the call
  const tools = buildCallTools(event.merchant_id, snap.phone, event.page_url);
  const placement = await getAgentPhone().placeCall({
    to: snap.phone,
    from: env.lassoPhoneNumber ?? "+10000000000",
    systemPrompt,
    voiceId: process.env.LASSO_VOICE_ID,
    tools,
    webhookUrl: `${env.publicUrl}/webhooks/agentphone`,
    metadata: { call_row_id: callRow.id, merchant_id: event.merchant_id },
  });

  await db.updateCall(callRow.id, {
    agentphone_call_id: placement.callId,
    status: placement.status === "failed" ? "failed" : "ringing",
  });

  return { call_id: callRow.id };
}

function buildCallTools(merchantId: string, phone: string, resumeUrl?: string): AgentPhoneTool[] {
  return [
    {
      name: "lookup_store",
      description:
        "Look up specific information about the store (products, pricing, shipping, returns, policies). Use this if the customer asks a question you don't immediately know the answer to.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "A natural-language question or 3-6 keyword search phrase." },
        },
        required: ["query"],
      },
    },
    {
      name: "send_checkout_link",
      description: "Send the customer a text message with a direct link back to their checkout. Use only after they agree.",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string", description: "Short SMS body. The checkout URL will be appended automatically." },
        },
        required: ["message"],
      },
    },
    {
      name: "offer_discount",
      description: "Offer the merchant's recovery discount code (if any) to recover the sale. Read it from merchant-private context — never invent one.",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string", description: "Internal: why you're offering it. Not spoken." },
        },
        required: ["reason"],
      },
    },
  ];
}

function secondsSince(ms?: number): number {
  if (!ms) return 0;
  return Math.max(0, (Date.now() - ms) / 1000);
}

function normalizePhone(s: string): string {
  return s.replace(/[^\d+]/g, "");
}

function cryptoRandomId(): string {
  // Stable UUID-ish without pulling node:crypto into ESM gotchas
  return ([1e7] + "-" + 1e3 + "-" + 4e3 + "-" + 8e3 + "-" + 1e11).replace(/[018]/g, (c) =>
    (Number(c) ^ (Math.random() * 16 >> (Number(c) / 4))).toString(16)
  );
}
