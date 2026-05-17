/**
 * Builds the system prompt for AgentPhone's voice agent on a recovery call.
 *
 * Inputs:
 *   - merchant brand-context (Supermemory)
 *   - merchant-private context (coupons, etc — also Supermemory)
 *   - caller history (prior Lasso calls)
 *   - cart + customer name + checkout URL from the abandonment event
 */

import type { MemoryRecord } from "../clients/supermemory.js";
import type { CallRow } from "../clients/supabase.js";

export type PromptInputs = {
  storeName: string;
  customerName?: string;
  phone: string;
  cartLines: Array<{ title?: string; qty?: number; price_cents?: number }>;
  cartTotalCents?: number;
  checkoutResumeUrl?: string;
  secondsSinceLeft: number;
  brandContext: MemoryRecord | null;
  privateContext: MemoryRecord | null;
  callerHistory: MemoryRecord[];
};

export function buildSystemPrompt(i: PromptInputs): string {
  const cart = i.cartLines.length
    ? i.cartLines.map((l) => `- ${l.qty ?? 1}× ${l.title ?? "(unknown item)"}${l.price_cents ? ` ($${(l.price_cents / 100).toFixed(2)})` : ""}`).join("\n")
    : "- (cart contents not captured)";

  const total = typeof i.cartTotalCents === "number" ? `$${(i.cartTotalCents / 100).toFixed(2)}` : "unknown total";

  const brand = i.brandContext?.text ?? "(no brand context available)";
  const priv = i.privateContext?.text ?? "";
  const history = i.callerHistory.length
    ? i.callerHistory
        .map((h, idx) => `- ${idx + 1}. ${h.text.slice(0, 240)}`)
        .join("\n")
    : "(first contact with this caller)";

  return `You are calling on behalf of ${i.storeName} about an abandoned checkout.

CONTEXT
- Customer name: ${i.customerName ?? "the customer"}
- Cart at time they left:
${cart}
- Cart total: ${total}
- Time since they left the site: ${Math.round(i.secondsSinceLeft)} seconds

WHAT WE KNOW ABOUT THIS STORE
${brand}

${priv ? `MERCHANT-PRIVATE CONTEXT\n${priv}\n` : ""}

WHAT WE KNOW ABOUT THIS CALLER FROM PRIOR CONTACT
${history}

JOB
1. Open warmly. Greet by name. Reference the specific item in their cart.
2. Ask one open question: "I noticed you were just checking out — was there something I could help with?"
3. Listen. If they raise an objection (price, shipping, sizing, trust), use the lookup_store tool to find the answer.
4. Offer ONE remedy if appropriate: the merchant-private discount code (if any), free shipping, or just the checkout link by SMS.
5. If they say yes, use send_checkout_link with the resume URL.
6. End the call within 90 seconds unless they're actively engaged.

CONSTRAINTS
- Never invent a discount code. Use only what's in the merchant-private context above.
- If they ask "how did you get my number," answer honestly: they entered it on the checkout page seconds ago.
- If they say "remove me" or "stop calling," respond yes and end the call. Never call back.
- Be brief. Voice calls are not chat — short turns, one idea at a time.`;
}
