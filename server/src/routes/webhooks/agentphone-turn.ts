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

    // Only handle inbound voice turns. SMS replies + outbound mirrors get logged.
    if (ev.event !== "agent.message") {
      console.log(`[lasso] webhook-turn: unhandled event=${ev.event}`);
      return reply.send({});
    }
    if (ev.data.direction !== "inbound") {
      // Outbound mirror — just acknowledge
      return reply.send({});
    }
    if (ev.channel !== "voice") {
      // SMS inbound is not in scope for this demo — log and continue
      console.log(`[lasso] webhook-turn: non-voice channel=${ev.channel}`);
      return reply.send({});
    }

    const turnResp = await handleVoiceTurn(ev);
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

  // 2. Pull context from Supermemory + (optionally) live Moss lookup
  const mem = getMemory();
  const memTag = `merchant:${merchant.id}:context`;
  const privTag = `merchant:${merchant.id}:private`;
  const [brandRecs, privRecs] = await Promise.all([mem.get(memTag), mem.get(privTag)]);

  const brand = brandRecs[0]?.text ?? "";
  const priv = privRecs[0]?.text ?? "";

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

  const history = (ev.recentHistory ?? [])
    .map((h) => `${h.direction === "inbound" ? "Customer" : "You"}: ${h.content}`)
    .join("\n");

  const system = `You are a recovery-call agent for ${merchant.name}. The customer just abandoned a checkout containing ${cartSummary} and you called them back. Respond conversationally, briefly (1-2 sentences). Use the context below to answer questions.

BRAND CONTEXT:
${brand}

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
- If the customer asks for the checkout link, set "send_sms": true and confirm warmly.
- If you can't help and the customer needs a human, use "action": "transfer".
- If the customer says they're not interested or to stop, set "hangup": true.

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

  // 5. Side effects (SMS) — do this BEFORE returning the response
  if (parsed.send_sms) {
    await sendCheckoutSmsBestEffort(merchant.id, call.phone, call.page_url, call.customer_name);
  }

  // 6. Translate to AgentPhone response shape
  const response: TurnResponse = { text: parsed.text ?? "Got it." };
  if (parsed.hangup) response.hangup = true;
  if (parsed.action === "transfer") response.action = "transfer";

  return response;
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

async function sendCheckoutSmsBestEffort(merchantId: string, toNumber: string, pageUrl: string | null | undefined, name?: string | null): Promise<void> {
  const shared = getSharedAgent();
  if (!shared) return;
  const link = pageUrl || "(checkout link)";
  const body = `${name ? `Hey ${name}, ` : ""}here's your checkout: ${link}`;
  try {
    await getAgentPhone().sendMessage({
      agentId: shared.agentId,
      toNumber,
      body,
      numberId: shared.numberId ?? undefined,
    });
    console.log(`[lasso] webhook-turn: SMS sent to ${toNumber}`);
  } catch (err) {
    console.warn("[lasso] webhook-turn: sendMessage failed", err);
  }
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

  const sig = (req.headers["x-webhook-signature"] as string | undefined) ?? "";
  if (!sig.startsWith("sha256=")) return false;
  const provided = sig.slice("sha256=".length);

  const rawBody = (req as unknown as { rawBody?: string }).rawBody ?? JSON.stringify(req.body ?? {});
  const expected = createHmac("sha256", shared.webhookSecret).update(rawBody).digest("hex");

  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(provided, "hex"));
  } catch {
    return false;
  }
}
