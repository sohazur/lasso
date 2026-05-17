/**
 * Founder-approval outbound call placer.
 *
 * Called from the closer agent's notify_founder action when the customer
 * has an objection that requires the merchant's explicit permission to
 * resolve (typically: unsupported shipping zone, custom alteration request,
 * one-off discount approval).
 *
 * Places a SECOND outbound AgentPhone call through the same shared Lasso
 * agent to merchant.founder_phone. The initial greeting (spoken by
 * AgentPhone's TTS when the founder picks up) is our one-shot brief —
 * it names the customer, what they want, and the blocker, then asks
 * for a yes/no. Subsequent turns route through the same webhook handler;
 * the 'founder_approval' branch there (commit #7) drives the response.
 *
 * Returns the founder call row id, or null if the call couldn't be placed
 * (missing founder_phone, AgentPhone error, etc).
 */

import { getStore, type CallRow, type MerchantRow } from "../clients/supabase.js";
import { getAgentPhone } from "../clients/agentphone.js";
import { getSharedAgent } from "./shared-agent.js";

export type FounderCallArgs = {
  customerCall: CallRow;
  merchant: MerchantRow;
  whatCustomerWants?: string | null;
  blocker?: string | null;
};

export async function placeFounderCall(args: FounderCallArgs): Promise<string | null> {
  const { customerCall, merchant, whatCustomerWants, blocker } = args;

  if (!merchant.founder_phone) {
    console.warn(`[lasso] founder-call: merchant ${merchant.id} has no founder_phone — skipping`);
    return null;
  }

  const shared = getSharedAgent();
  if (!shared) {
    console.warn(`[lasso] founder-call: shared agent not initialized — skipping`);
    return null;
  }

  const db = getStore();
  const customerName = customerCall.customer_name ?? "a customer";
  const what = whatCustomerWants?.trim() || "to complete their purchase";
  const why = blocker?.trim() || "an issue I couldn't resolve on my own";
  const founderName = merchant.founder_name ?? "there";

  // ─── The initial greeting ─────────────────────────────────────────────
  // AgentPhone speaks this via TTS the moment the founder picks up — this
  // is our ONE shot to brief them before our webhook handler takes over.
  // Keep it short and end with an explicit yes/no question so the speech
  // recognizer has clean signal on the first reply.
  const initialGreeting =
    `Hi ${founderName}, this is the Lasso agent calling on behalf of ${merchant.name}. ` +
    `I've got ${customerName} on a recovery call right now — they want ${what}, ` +
    `but ${why}. Can I tell them yes? Just say yes or no.`;

  // The systemPrompt at placeCall is largely a placeholder in webhook mode
  // (our handler drives each turn) but the API may still require it as
  // non-empty. Keep it brief and aligned with the brief.
  const systemPrompt =
    `You are calling ${merchant.name}'s store owner (${founderName}) about a customer ` +
    `who needs their approval to complete a purchase. The customer wants ${what}, ` +
    `but ${why}. Capture a yes/no answer. The webhook will drive subsequent turns.`;

  let founderCallRow: CallRow;
  try {
    // Insert the founder_approval row FIRST so we have an id to correlate
    // when AgentPhone's webhook fires back with the founder's inbound turn.
    founderCallRow = await db.insertCall({
      id: cryptoRandomId(),
      merchant_id: merchant.id,
      phone: merchant.founder_phone,
      kind: "founder_approval",
      trigger: "notify_founder",
      status: "preparing",
      cart_lines: customerCall.cart_lines ?? [],
      cart_total_cents: customerCall.cart_total_cents ?? null,
      customer_name: founderName,
      // Store the brief on the row so the founder-side webhook handler
      // (commit #7) can re-read it without re-deriving from history.
      pending_action_params: {
        what_customer_wants: what,
        blocker: why,
        customer_call_id: customerCall.id,
        customer_name: customerName,
        customer_phone: customerCall.phone,
      },
    });
  } catch (err) {
    console.error("[lasso] founder-call: failed to insert founder_approval row", err);
    return null;
  }

  try {
    const placement = await getAgentPhone().placeCall({
      agentId: shared.agentId,
      toNumber: merchant.founder_phone,
      fromNumberId: shared.numberId ?? undefined,
      systemPrompt,
      initialGreeting,
      variables: {
        merchant_name: merchant.name,
        customer_name: customerName,
        founder_name: founderName,
        what_customer_wants: what,
        blocker: why,
      },
    });
    await db.updateCall(founderCallRow.id, {
      agentphone_call_id: placement.callId,
      status: placement.status === "failed" ? "failed" : "ringing",
    });
    console.log(
      `[lasso] founder-call: placed founder_call=${founderCallRow.id} apc=${placement.callId} → ${merchant.founder_phone}`
    );
    return founderCallRow.id;
  } catch (err) {
    console.error("[lasso] founder-call: placeCall failed", err);
    await db.updateCall(founderCallRow.id, { status: "failed", outcome: "error" });
    return founderCallRow.id;
  }
}

function cryptoRandomId(): string {
  // Match the same UUID-ish generator the orchestrator uses so ids are
  // visually distinguishable from real UUIDs in logs without dragging in
  // node:crypto's ESM quirks.
  return ([1e7] + "-" + 1e3 + "-" + 4e3 + "-" + 8e3 + "-" + 1e11).replace(/[018]/g, (c) =>
    (Number(c) ^ (Math.random() * 16 >> (Number(c) / 4))).toString(16)
  );
}
