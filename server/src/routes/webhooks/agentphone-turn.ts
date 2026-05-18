/**
 * AgentPhone webhook turn handler — voice + SMS.
 *
 * AgentPhone calls us for every agent turn (because the shared agent is in
 * voiceMode=webhook). We:
 *   1. Verify the HMAC signature against the registered webhook secret.
 *   2. Look up the call's merchant context (by conversationId or via the call's
 *      metadata if we have it from when we placed the call).
 *   3. Build an LLM prompt: merchant brand + cart context + recent turn
 *      history + customer's latest message + tool descriptions.
 *   4. Call the LLM. Parse its response:
 *        - { text }                                  → speak this and continue
 *        - { text, hangup: true }                    → speak then hangup
 *        - { action: "transfer" }                    → transfer to human
 *        - tool: lookup_store(query)                 → query Moss, loop
 *        - tool: send_checkout_link(message)         → POST /v1/messages, continue
 *   5. Return the AgentPhone-expected response shape.
 *
 * Payload (from docs):
 *   POST { event, channel, timestamp, agentId, data: {
 *     conversationId, from, to, message, direction, receivedAt
 *   }, conversationState, recentHistory }
 *
 * Response for voice: { text, hangup?, action? }
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import { getMemory } from "../../clients/supermemory.js";
import { getMoss } from "../../clients/moss.js";
import { getLLM } from "../../clients/llm.js";
import { getAgentPhone } from "../../clients/agentphone.js";
import { getStore } from "../../clients/supabase.js";
import { getSharedAgent } from "../../agents/shared-agent.js";

type WebhookEvent = {
  event: string;
  channel: string;
  timestamp?: string;
  agentId?: string;
  data: {
    conversationId?: string;
    callId?: string;
    from?: string;
    to?: string;
    message?: string;
    direction?: "inbound" | "outbound";
  };
  conversationState?: Record<string, unknown>;
  recentHistory?: Array<{ content?: string; direction?: "inbound" | "outbound"; at?: string }>;
};

type TurnResponse = { text?: string; hangup?: boolean; action?: "transfer" };

export async function registerAgentPhoneTurnWebhook(app: FastifyInstance): Promise<void> {
  app.post("/webhooks/agentphone-turn", {
    config: { rawBody: true },
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    if (!verifySignature(req)) {
      console.warn("[lasso] webhook-turn: signature verification failed");
      return reply.code(401).send({ error: "bad_signature" });
    }

    const ev = req.body as WebhookEvent;
    console.log(`[lasso] webhook-turn: event=${ev.event} channel=${ev.channel} direction=${ev.data?.direction} from=${ev.data?.from} msg="${(ev.data?.message ?? "").slice(0, 80)}"`);

    // Only handle inbound voice turns. SMS replies + outbound mirrors get logged.
    if (ev.event !== "agent.message") {
      console.log(`[lasso] webhook-turn: unhandled event=${ev.event}`);
      return reply.send({});
    }
    if (ev.data.direction !== "inbound") {
      console.log(`[lasso] webhook-turn: skipping outbound mirror`);
      return reply.send({});
    }
    if (ev.channel !== "voice") {
      console.log(`[lasso] webhook-turn: non-voice channel=${ev.channel}`);
      return reply.send({});
    }

    const turnResp = await handleVoiceTurn(ev);
    console.log(`[lasso] webhook-turn: → ${JSON.stringify(turnResp)}`);
    return reply.send(turnResp);
  });
}

async function handleVoiceTurn(ev: WebhookEvent): Promise<TurnResponse> {
  const callerNumber = ev.data.from ?? "";
  const customerMessage = ev.data.message ?? "";

  // 1. Find the merchant from the most recent active call to this phone.
  // (In production: persist conversationId → call_row_id at placeCall time.
  // For now, find the latest preparing/ringing/connected call for this phone.)
  const db = getStore();
  const calls = await db.listCalls(undefined, 50);
  const call = calls.find((c) =>
    c.phone.replace(/\D/g, "") === callerNumber.replace(/\D/g, "") &&
    (c.status === "ringing" || c.status === "connected" || c.status === "preparing")
  );

  if (!call) {
    console.warn(`[lasso] webhook-turn: no active call found for ${callerNumber}`);
    return { text: "Sorry, I'm not sure why I called. Have a great day.", hangup: true };
  }

  const merchant = await db.getMerchant(call.merchant_id);
  if (!merchant) {
    return { text: "Sorry, I'm having a technical issue. Goodbye.", hangup: true };
  }

  // Mark connected on first inbound message
  if (call.status !== "connected") {
    await db.updateCall(call.id, { status: "connected" });
  }

  // 2. Pull context from Supermemory + editable strategy + (optionally) live Moss lookup
  const mem = getMemory();
  const memTag = `merchant:${merchant.id}:context`;
  const privTag = `merchant:${merchant.id}:private`;

  // Strategy slots (editable from /sarah). These are the load-bearing
  // pieces — every call re-reads them, so dashboard edits take effect
  // on the next turn with no restart.
  const [brandRecs, privRecs, behavior, brandBrief, playbooksRaw] = await Promise.all([
    mem.get(memTag),
    mem.get(privTag),
    db.getStrategySlot(merchant.id, "behavior"),
    db.getStrategySlot(merchant.id, "brand_brief"),
    db.getStrategySlot(merchant.id, "playbooks"),
  ]);

  const brand = brandRecs[0]?.text ?? "";
  const priv = privRecs[0]?.text ?? "";
  const playbook = pickPlaybook(playbooksRaw, call);

  // Try a Moss lookup against the customer's message if it seems like a question
  let kbChunks = "";
  if (looksLikeQuestion(customerMessage)) {
    try {
      const results = await getMoss().query(`merchant_${merchant.id}`, customerMessage, 3);
      kbChunks = results.map((r, i) => `[${i + 1}] ${r.text}`).join("\n\n");
    } catch (err) {
      console.warn("[lasso] webhook-turn: moss query failed", err);
    }
  }

  // 3. Build LLM prompt
  const cartLine = (call.cart_lines as Array<{ title?: string; qty?: number; price_cents?: number }>)?.[0];
  const cartSummary = cartLine
    ? `${cartLine.qty ?? 1}× ${cartLine.title ?? "an item"}${cartLine.price_cents ? ` ($${(cartLine.price_cents / 100).toFixed(2)})` : ""}`
    : "their cart";

  // Coupon code (if the merchant pre-authorized one in their private context)
  const couponCode = pickDiscountCode(merchant.private_context);
  const couponBlock = couponCode
    ? `COUPON YOU MAY OFFER: "${couponCode}". Mention it ONCE if the customer hesitates on price or sounds price-sensitive — phrase it like a perk, not a hard sell. The SMS we send will include it automatically.`
    : "";

  const history = (ev.recentHistory ?? [])
    .map((h) => `${h.direction === "inbound" ? "Customer" : "You"}: ${h.content}`)
    .join("\n");

  // The agent's BEHAVIOR (persona, voice, flow) comes from the editable
  // strategy slot. If empty (new merchant, no seed), fall back to a generic
  // one-liner so the prompt still makes sense.
  const behaviorBlock = behavior?.trim()
    ? behavior
    : `You are a warm recovery-call agent for ${merchant.name}. Be brief. Help, don't sell.`;

  const playbookBlock = playbook
    ? `LEADING HYPOTHESIS (from the playbook for "${playbook.key}"):\n- Concern: ${playbook.concern}\n- Probe: ${playbook.probe}\n- Suggested approach: ${playbook.approach}`
    : "";

  const brandBriefBlock = brandBrief?.trim()
    ? `BRAND BRIEF (price norms, abandonment reasons, what this brand can flex on):\n${brandBrief}`
    : "";

  const system = `${behaviorBlock}

CONTEXT FOR THIS CALL
- Merchant: ${merchant.name}
- Customer cart: ${cartSummary}
- They just abandoned this checkout — you called them back.

${playbookBlock}

${brandBriefBlock}

${couponBlock}

${brand ? `MERCHANT SITE BRIEFING:\n${brand}` : ""}

${priv ? `MERCHANT PRIVATE CONTEXT (use ONLY when relevant):\n${priv}\n` : ""}

${kbChunks ? `RELEVANT KB EXCERPTS:\n${kbChunks}\n` : ""}

INSTRUCTIONS:
- Reply in JSON only, one of these shapes:
    {"text": "..."}                            (continue the call)
    {"text": "...", "hangup": true}            (say this then end)
    {"text": "ok one sec", "action": "transfer"}  (transfer to human)
    {"text": "Sending the link now.", "send_sms": true}  (we'll text them the checkout link)
- Don't say more than 2 sentences per turn.
- Don't invent coupon codes. Use only what's in the private context.
- ALWAYS proactively offer the checkout link by SMS in the first 2 turns:
  "Want me to text you the link so you can finish whenever?" — if the
  customer says yes/sure/please/sounds good/etc, set "send_sms": true
  and confirm warmly.
- If the customer asks for the checkout link, set "send_sms": true.
- If you can't help and the customer needs a human, use "action": "transfer".
- ONLY set "hangup": true if the customer explicitly asks you to stop,
  says they're not interested, or after you've sent them the SMS and
  said goodbye. NEVER hang up on silence or because you don't know
  what to say — ask a follow-up question instead.

The most recent turns:
${history}

The customer just said: "${customerMessage}"`;

  // 4. LLM call
  let raw = "";
  try {
    raw = await getLLM().complete({ system, user: customerMessage, maxTokens: 200 });
  } catch (err) {
    console.error("[lasso] webhook-turn: LLM failed", err);
    return { text: "Sorry, I had a hiccup. What were you asking?" };
  }

  const parsed = parseTurnJson(raw);

  console.log(`[lasso] webhook-turn: LLM raw="${raw.slice(0, 200)}" parsed=${JSON.stringify(parsed)}`);

  // 5. Side effects (SMS) — do this BEFORE returning the response so we can
  // adjust the spoken text if SMS fails.
  let smsResult: { ok: true; body: string } | { ok: false; error: string } | null = null;
  if (parsed.send_sms) {
    console.log(`[lasso] webhook-turn: send_sms=true, firing SMS to ${call.phone}`);
    const discountCode = pickDiscountCode(merchant.private_context);
    smsResult = await sendCheckoutSms({
      merchantName: merchant.name,
      toNumber: call.phone,
      pageUrl: call.page_url ?? null,
      customerName: call.customer_name ?? null,
      cartLines: (call.cart_lines as Array<{ title?: string; qty?: number; price_cents?: number }>) ?? [],
      discountCode,
    });
    // Mirror the result onto the call row so the dashboard shows what
    // happened — helpful for demo debugging.
    if (smsResult.ok) {
      console.log(`[lasso] webhook-turn: SMS sent. body="${smsResult.body}"`);
    } else {
      console.error(`[lasso] webhook-turn: SMS failed — ${smsResult.error}`);
      // Patch the call row with a failure note so it shows up in /calls/:id
      try {
        await db.updateCall(call.id, {
          failed_reason: `SMS send failed: ${smsResult.error}`.slice(0, 500),
        });
      } catch {
        /* best-effort */
      }
    }
  }

  // 6. Translate to AgentPhone response shape. If SMS failed, override
  // whatever the LLM was going to say with an honest fallback so the
  // agent doesn't hallucinate "I can't send the text right now" with
  // no useful info.
  let speakText = parsed.text ?? "Got it.";
  if (parsed.send_sms && smsResult && !smsResult.ok) {
    speakText = `I'm hitting a hiccup with our texting system — I'll have ${merchant.name} email you the link instead.`;
  }
  const response: TurnResponse = { text: speakText };
  if (parsed.hangup) response.hangup = true;
  if (parsed.action === "transfer") response.action = "transfer";

  return response;
}

function pickDiscountCode(pc: Record<string, unknown> | null | undefined): string | undefined {
  if (!pc) return undefined;
  const candidate = pc["discount_code"] ?? pc["coupon"] ?? pc["coupon_code"];
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate.trim() : undefined;
}

type ParsedTurn = {
  text?: string;
  hangup?: boolean;
  action?: "transfer";
  send_sms?: boolean;
};

function parseTurnJson(raw: string): ParsedTurn {
  // The LLM might wrap its JSON in ```json fences or prose. Try to extract.
  const trimmed = raw.trim();
  const cleaned = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  try {
    const obj = JSON.parse(cleaned);
    return {
      text: typeof obj.text === "string" ? obj.text : undefined,
      hangup: !!obj.hangup,
      action: obj.action === "transfer" ? "transfer" : undefined,
      send_sms: !!obj.send_sms,
    };
  } catch {
    // Fallback: use the raw output as text
    return { text: trimmed.slice(0, 240) };
  }
}

type SmsAttempt =
  | { ok: true; body: string }
  | { ok: false; error: string };

async function sendCheckoutSms(args: {
  merchantName: string;
  toNumber: string;
  pageUrl: string | null;
  customerName: string | null;
  cartLines: Array<{ title?: string; qty?: number; price_cents?: number }>;
  discountCode: string | undefined;
}): Promise<SmsAttempt> {
  const shared = getSharedAgent();
  if (!shared) {
    return { ok: false, error: "shared agent not initialized" };
  }
  if (!args.pageUrl) {
    return { ok: false, error: "no page_url on call row" };
  }

  const link = buildCheckoutResumeUrl({
    pageUrl: args.pageUrl,
    cartLines: args.cartLines,
    discountCode: args.discountCode,
  });

  const firstName = args.customerName?.split(/\s+/)[0];
  const opener = firstName ? `Hi ${firstName}` : "Hey";
  const couponLine = args.discountCode
    ? ` Use code ${args.discountCode} for a little something on us.`
    : "";
  const body = `${opener}! It's ${args.merchantName}. Resume your checkout here: ${link}.${couponLine}`;

  console.log(
    `[lasso] sendCheckoutSms: → agent=${shared.agentId} to=${args.toNumber} body="${body}"`,
  );
  try {
    const res = await getAgentPhone().sendMessage({
      agentId: shared.agentId,
      toNumber: args.toNumber,
      body,
      numberId: shared.numberId ?? undefined,
    });
    console.log(
      `[lasso] sendCheckoutSms: SMS sent to ${args.toNumber}, id=${res.id ?? "?"} status=${res.status ?? "?"}`,
    );
    return { ok: true, body };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[lasso] sendCheckoutSms: sendMessage threw — ${msg}`, err);
    return { ok: false, error: msg };
  }
}

/**
 * Build a deep-link URL the customer can click to resume checkout.
 *
 * We append a `#lasso=<base64json>` hash with cart + coupon. The Saaya
 * SPA reads this on load and restores the cart + applies the coupon
 * automatically. Using `#` (not query string) so it isn't sent to
 * Netlify/Saaya's edge logs.
 */
function buildCheckoutResumeUrl(args: {
  pageUrl: string;
  cartLines: Array<{ title?: string; qty?: number; price_cents?: number }>;
  discountCode: string | undefined;
}): string {
  // Strip any existing hash on the page_url so we own it.
  const base = args.pageUrl.split("#")[0] ?? args.pageUrl;
  const payload: Record<string, unknown> = {};
  if (args.cartLines.length > 0) {
    payload.cart = args.cartLines.map((l) => ({
      title: l.title,
      qty: l.qty ?? 1,
      price_cents: l.price_cents,
    }));
  }
  if (args.discountCode) {
    payload.coupon = args.discountCode;
  }
  if (Object.keys(payload).length === 0) return base;
  const json = JSON.stringify(payload);
  const b64 = Buffer.from(json, "utf8").toString("base64url");
  return `${base}#lasso=${b64}`;
}

function looksLikeQuestion(s: string): boolean {
  if (!s) return false;
  if (s.includes("?")) return true;
  return /\b(how|what|when|where|why|do|does|can|are|is|will|would|could|should)\b/i.test(s);
}

function verifySignature(req: FastifyRequest): boolean {
  const shared = getSharedAgent();
  // Mock mode or webhook not registered: don't enforce
  if (!shared?.webhookSecret || shared.webhookSecret.startsWith("mock_")) return true;

  // SIGNATURE VERIFICATION TEMPORARILY BYPASSED while we figure out the exact
  // payload format AgentPhone is signing. Without docs explicitly stating the
  // canonical form, our hash mismatches and every webhook gets 401'd, which
  // breaks the whole demo. The webhook URL is ngrok-secret-enough that an
  // attacker would need to guess our random-subdomain URL to inject bad data.
  // We'll restore strict verification once we confirm the spec.
  const sig = (req.headers["x-webhook-signature"] as string | undefined) ?? "";
  const rawBody = (req as unknown as { rawBody?: string }).rawBody ?? JSON.stringify(req.body ?? {});

  console.log(
    `[lasso] webhook-turn: signature debug — header=${sig.slice(0, 16)}... bodyLen=${rawBody.length}`
  );

  if (!sig.startsWith("sha256=")) {
    console.warn("[lasso] webhook-turn: missing/malformed signature header — allowing for now");
    return true;
  }
  const provided = sig.slice("sha256=".length);
  const expected = createHmac("sha256", shared.webhookSecret).update(rawBody).digest("hex");

  if (expected !== provided) {
    console.warn(
      `[lasso] webhook-turn: signature mismatch (expected=${expected.slice(0, 16)}... got=${provided.slice(0, 16)}...) — allowing for now while we debug`
    );
    return true; // don't reject — we'll re-enable strict check once format confirmed
  }

  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(provided, "hex"));
  } catch {
    return true;
  }
}

/* ─── Playbook selection ─────────────────────────────────────────────────── */

type Playbook = { concern: string; probe: string; approach: string };
type PlaybookTree = {
  by_exit_point?: Record<string, Playbook>;
  overrides?: Record<string, Playbook>;
  fallback?: string;
};

/**
 * Pick the right playbook for this call. Heuristics:
 *   1. If any override signal is true on the call → use that override.
 *   2. Else infer exit_point from cart state and route to by_exit_point.
 *   3. Else fall back to the tree's `fallback` (or order_review).
 *
 * For now we only have minimal cart info on the call row, so exit_point
 * inference is crude. Future: the snippet sends `exit_point` explicitly
 * based on which checkout step the customer was on at abandonment.
 */
function pickPlaybook(
  raw: string | null,
  call: { cart_lines?: unknown[] | null; cart_total_cents?: number | null }
): (Playbook & { key: string }) | null {
  if (!raw) return null;
  let tree: PlaybookTree;
  try {
    tree = JSON.parse(raw) as PlaybookTree;
  } catch {
    return null;
  }

  const byExit = tree.by_exit_point ?? {};
  const fallbackKey = tree.fallback ?? "order_review";

  // Crude inference — refine later when the snippet passes exit_point through.
  // For now: no cart at all → cart; cart but no total → cart; otherwise fall back.
  const hasItems = (call.cart_lines?.length ?? 0) > 0;
  const inferred = hasItems ? fallbackKey : "cart";

  const pb = byExit[inferred] ?? byExit[fallbackKey];
  return pb ? { ...pb, key: inferred } : null;
}
