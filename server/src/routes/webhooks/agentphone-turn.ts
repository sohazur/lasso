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

type CallEndedTranscriptTurn = { role?: string; content?: string };

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
    // SMS / iMessage payloads use `message`; voice payloads use `transcript`.
    message?: string;
    transcript?: string | CallEndedTranscriptTurn[];
    confidence?: number;
    status?: string;
    direction?: "inbound" | "outbound";
    durationSeconds?: number;
    startedAt?: string;
    endedAt?: string;
    disconnectionReason?: string;
    summary?: string;
    userSentiment?: string;
    callSuccessful?: boolean;
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
    const voiceText =
      typeof ev.data?.transcript === "string"
        ? ev.data.transcript
        : ev.data?.message ?? "";
    console.log(
      `[lasso] webhook-turn: event=${ev.event} channel=${ev.channel} direction=${ev.data?.direction} from=${ev.data?.from} content="${voiceText.slice(0, 80)}"`,
    );

    // agent.call_ended is fire-and-forget — full final transcript + analysis.
    if (ev.event === "agent.call_ended") {
      await handleCallEnded(ev);
      return reply.send({ ok: true });
    }

    // Only handle inbound voice turns for the conversational loop.
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

/**
 * Persist the final transcript + status when AgentPhone fires
 * agent.call_ended. Without this our call rows stay at `ringing`
 * forever and the transcript card stays empty.
 */
async function handleCallEnded(ev: WebhookEvent): Promise<void> {
  const callerNumber = ev.data.from ?? "";
  const agentphoneCallId = ev.data.callId ?? ev.data.conversationId;
  const db = getStore();

  // Try to find the row by AgentPhone callId first, then fall back to
  // the most recent active call for this phone.
  const recent = await db.listCalls(undefined, 50);
  let call =
    recent.find((c) => agentphoneCallId && c.agentphone_call_id === agentphoneCallId) ?? null;
  if (!call) {
    const digits = callerNumber.replace(/\D/g, "");
    call =
      recent.find(
        (c) =>
          c.phone.replace(/\D/g, "") === digits &&
          (c.status === "ringing" || c.status === "connected"),
      ) ?? null;
  }
  if (!call) {
    console.warn(`[lasso] call_ended: no matching call for ${agentphoneCallId ?? callerNumber}`);
    return;
  }

  // Compose the transcript text from the array AgentPhone sends.
  const transcript = Array.isArray(ev.data.transcript)
    ? ev.data.transcript
        .map((t) => {
          const who = (t.role ?? "").toLowerCase() === "agent" ? "Agent" : "Customer";
          return t.content ? `${who}: ${t.content}` : "";
        })
        .filter(Boolean)
        .join("\n")
    : typeof ev.data.transcript === "string"
      ? ev.data.transcript
      : null;

  await db.updateCall(call.id, {
    status: "completed",
    duration_secs: ev.data.durationSeconds ?? call.duration_secs ?? null,
    transcript: transcript ?? call.transcript ?? null,
    ended_at: ev.data.endedAt ?? new Date().toISOString(),
  });
  console.log(`[lasso] call_ended: persisted transcript (${transcript?.length ?? 0} chars) for call ${call.id}`);

  // Mirror transcript to Supermemory so the next call to this phone has it.
  if (transcript) {
    const tag = `merchant:${call.merchant_id}:phone:${callerNumber.replace(/\D/g, "")}`;
    try {
      await getMemory().store(tag, {
        text: transcript,
        metadata: {
          call_id: call.id,
          duration_secs: ev.data.durationSeconds ?? null,
          summary: ev.data.summary ?? null,
          sentiment: ev.data.userSentiment ?? null,
          ended_at: new Date().toISOString(),
        },
      });
    } catch (err) {
      console.warn("[lasso] call_ended: persisting transcript to supermemory failed", err);
    }
  }

  // Now the call is fully ended, fire any queued SMS. AgentPhone won't
  // accept /messages while a call is in progress, so this is the only
  // safe time. Don't await — caller (the webhook handler) needs to
  // return 200 quickly to avoid retries.
  void dispatchQueuedSms(call.id, call.merchant_id);
}

async function handleVoiceTurn(ev: WebhookEvent): Promise<TurnResponse> {
  const callerNumber = ev.data.from ?? "";
  // Voice turns carry the customer's words in `data.transcript`. SMS turns
  // use `data.message`. Accept either so the conversation loop works for
  // both channels — and so it actually receives content (the previous
  // `message`-only read was always empty for voice).
  const customerMessage =
    (typeof ev.data.transcript === "string" ? ev.data.transcript : "") ||
    ev.data.message ||
    "";

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

  // 3. Build LLM prompt — fold duplicate titles into a single line so
  // multi-variant carts don't read like "1× Zara, 1× Zara, 1× Zara".
  const rawLines =
    (call.cart_lines as Array<{ title?: string; qty?: number; price_cents?: number }>) ?? [];
  const allCartLines: Array<{ title?: string; qty: number; price_cents?: number }> = [];
  {
    const byTitle = new Map<string, { title?: string; qty: number; price_cents?: number }>();
    for (const l of rawLines) {
      const key = (l.title ?? "").toLowerCase().trim() || `__anon_${allCartLines.length}`;
      const existing = byTitle.get(key);
      if (existing) {
        existing.qty += l.qty ?? 1;
      } else {
        const next = { title: l.title, qty: l.qty ?? 1, price_cents: l.price_cents };
        byTitle.set(key, next);
        allCartLines.push(next);
      }
    }
  }
  const cartSummary =
    allCartLines.length === 0
      ? "their cart (we didn't capture the specific items)"
      : allCartLines
          .slice(0, 3)
          .map((l) => `${l.qty}× ${l.title ?? "item"}`)
          .join(", ") + (allCartLines.length > 3 ? `, and ${allCartLines.length - 3} more` : "");

  const customerFirstName = call.customer_name?.split(/\s+/)[0] ?? null;

  // Coupon code — searched across the knowledge-base text channels first
  // (brand brief + private context records that the merchant can edit from
  // /sarah), then fall back to the merchant.private_context DB column for
  // legacy carriage.
  const couponCode = pickDiscountCode(brandBrief, priv, brand, merchant.private_context);
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
- Customer: ${customerFirstName ?? "name unknown"}${call.customer_name ? ` (${call.customer_name})` : ""}
- Phone: ${call.phone}
- Cart they were looking at: ${cartSummary}
- They were mid-checkout (not yet purchased) and stepped away. You
  called them back — assume they're "in between" deciding, not that
  they've definitely abandoned. Address them by first name if known.
- Important: never say "you tried to buy" — phrase it as "I saw you
  were looking at" or "I noticed you were checking out".

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
    {"text": "I'll text you the link right after we hang up.", "send_sms": true}
       (we queue the SMS; it sends the moment the call ends)
- Don't say more than 2 sentences per turn.
- Don't invent coupon codes. Use only what's in the private context.
- ALWAYS proactively offer the checkout link by SMS in the first 2 turns:
  "Want me to text you the link so you can finish whenever?" — if the
  customer says yes/sure/please/sounds good/etc, set "send_sms": true
  and tell them you'll send it as soon as the call ends. NEVER say
  "sending the link now" or "I'll send it right now" — the text only
  fires after we hang up. Phrasing: "I'll text it the moment we hang
  up" or "you'll get it the second this call ends".
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

  // 5. SMS — AgentPhone explicitly does NOT allow sending SMS while a
  // call is in progress on the same line. So we don't send here; we
  // queue the payload and dispatch it from handleCallEnded() once the
  // call hangs up. The agent's spoken response should promise the
  // text "as soon as we hang up".
  if (parsed.send_sms) {
    // Same KB-first lookup as the in-prompt couponBlock so the SMS body
    // and the agent's spoken offer stay consistent.
    const discountCode = pickDiscountCode(brandBrief, priv, brand, merchant.private_context);
    queuePostCallSms(call.id, {
      merchantName: merchant.name,
      toNumber: call.phone,
      pageUrl: call.page_url ?? null,
      customerName: call.customer_name ?? null,
      cartLines:
        (call.cart_lines as Array<{ title?: string; qty?: number; price_cents?: number }>) ?? [],
      discountCode,
    });
    console.log(`[lasso] webhook-turn: queued SMS for call ${call.id}`);
  }

  // 6. Translate to AgentPhone response shape.
  const response: TurnResponse = { text: parsed.text ?? "Got it." };
  if (parsed.hangup) response.hangup = true;
  if (parsed.action === "transfer") response.action = "transfer";

  return response;
}

// ───────────── Post-call SMS queue ─────────────
type PendingSms = {
  merchantName: string;
  toNumber: string;
  pageUrl: string | null;
  customerName: string | null;
  cartLines: Array<{ title?: string; qty?: number; price_cents?: number }>;
  discountCode: string | undefined;
};

const pendingSmsByCallId = new Map<string, PendingSms>();

function queuePostCallSms(callId: string, payload: PendingSms): void {
  pendingSmsByCallId.set(callId, payload);
}

async function dispatchQueuedSms(
  callId: string,
  merchantId: string,
): Promise<void> {
  const pending = pendingSmsByCallId.get(callId);
  if (!pending) return;
  pendingSmsByCallId.delete(callId);

  const result = await sendCheckoutSms(pending);
  if (result.ok) {
    console.log(`[lasso] post-call SMS sent for call ${callId}. body="${result.body}"`);
    return;
  }
  console.error(`[lasso] post-call SMS failed for call ${callId} — ${result.error}`);
  // Surface to the dashboard so a failed SMS doesn't disappear into the void
  try {
    await getStore().updateCall(callId, {
      failed_reason: `SMS send failed (post-call): ${result.error}`.slice(0, 500),
    });
  } catch {
    /* best-effort */
  }
  // Touch merchantId so the param isn't unused (future: per-merchant fallback channels)
  void merchantId;
}

/**
 * Pull a coupon code out of the merchant's knowledge-base text. The agent
 * reads its brand briefing + private context (both Supermemory-backed) on
 * every call; the coupon lives in there as natural language so the
 * merchant can edit it in /sarah without touching DB columns. Recognises:
 *   - "discount_code: LASSOXX" / "coupon: LASSOXX"
 *   - "use code LASSOXX" / "code LASSOXX"
 *   - lone tokens like LASSO15 / SAAYA10 / WELCOME20 in any text
 * Falls back to the legacy private_context column for backwards-compat.
 */
function pickDiscountCode(
  ...sources: Array<string | Record<string, unknown> | null | undefined>
): string | undefined {
  // Pattern 1: explicit key=value form ("discount_code: LASSO15", "code: LASSO15").
  // The value must look like a coupon — uppercase token with 4+ chars total,
  // so we don't match the literal word "code" in "code: LASSO15".
  const labelled =
    /(?:discount[_\s-]?code|coupon[_\s-]?code|coupon|promo[_\s-]?code|code)\s*[:=]\s*([A-Z][A-Z0-9_-]{3,24})\b/i;
  // Pattern 2: lone uppercase token containing at least one digit (filters
  // out plain words like "BRIDAL", "PAKISTAN") and 4+ chars long.
  const bareCode = /\b([A-Z]{3,}\d{1,3}[A-Z0-9]{0,8})\b/;

  for (const src of sources) {
    if (!src) continue;
    if (typeof src === "string") {
      const m1 = src.match(labelled);
      if (m1?.[1]) return m1[1].toUpperCase();
      const m2 = src.match(bareCode);
      if (m2?.[1]) return m2[1].toUpperCase();
    } else if (typeof src === "object") {
      const candidate = src["discount_code"] ?? src["coupon"] ?? src["coupon_code"];
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        return candidate.trim().toUpperCase();
      }
    }
  }
  return undefined;
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

  // AgentPhone signs `${timestamp}.${rawBody}` with HMAC-SHA256, not the
  // body alone. See docs: https://docs.agentphone.ai/.../webhooks#signatures
  // We also enforce a 5-minute timestamp window to prevent replays.
  const sig = (req.headers["x-webhook-signature"] as string | undefined) ?? "";
  const ts = (req.headers["x-webhook-timestamp"] as string | undefined) ?? "";
  const rawBody = (req as unknown as { rawBody?: string }).rawBody;
  if (!rawBody) {
    // No raw body captured — this is a fastify-raw-body wiring bug. Bail
    // safely (allow) and log so we can fix it rather than reject every
    // delivery as malformed.
    console.warn("[lasso] webhook-turn: rawBody is missing — allowing (fix rawBody plugin config)");
    return true;
  }

  if (!sig.startsWith("sha256=")) {
    console.warn("[lasso] webhook-turn: missing/malformed signature header — allowing for now");
    return true;
  }
  if (!ts) {
    console.warn("[lasso] webhook-turn: missing X-Webhook-Timestamp — allowing for now");
    return true;
  }
  const ageSecs = Math.abs(Date.now() / 1000 - parseInt(ts, 10));
  if (Number.isNaN(ageSecs) || ageSecs > 300) {
    console.warn(`[lasso] webhook-turn: timestamp out of range (${ageSecs}s) — allowing for now`);
    return true;
  }

  const provided = sig.slice("sha256=".length);
  const signedString = `${ts}.${rawBody}`;
  const expected = createHmac("sha256", shared.webhookSecret).update(signedString).digest("hex");

  try {
    const eq = timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(provided, "hex"));
    if (!eq) {
      console.warn(
        `[lasso] webhook-turn: signature mismatch (expected=${expected.slice(0, 16)}... got=${provided.slice(0, 16)}...)`,
      );
    }
    return eq;
  } catch {
    return false;
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
