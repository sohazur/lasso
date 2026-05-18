/**
 * Shared Lasso agent bootstrap.
 *
 * One AgentPhone agent + one phone number is used for ALL merchants. The
 * per-merchant brand context goes into the systemPrompt of each outbound
 * call. Webhook mode means our server gets called for every voice turn.
 *
 * Idempotent: at boot, find-or-create the agent by name. Save its ID +
 * webhook secret in memory so the rest of the app can use it.
 */

import { getAgentPhone, type AgentResponse } from "../clients/agentphone.js";
import { env } from "../clients/config.js";

const SHARED_AGENT_NAME = "Lasso Shared Agent";

export type SharedAgentInfo = {
  agentId: string;
  numberId: string | null;
  phoneNumber: string | null;
  webhookSecret: string | null;
};

let _shared: SharedAgentInfo | null = null;

export function getSharedAgent(): SharedAgentInfo | null {
  return _shared;
}

export async function ensureSharedAgent(): Promise<SharedAgentInfo> {
  if (_shared) return _shared;

  // Fast path: if .env tells us which agent + number to use, trust it and skip
  // the listAgents() round-trip. Useful when AgentPhone's API is slow or down.
  if (env.sharedAgentId) {
    // If LASSO_SHARED_WEBHOOK_SECRET is set, trust it as the source of
    // truth and skip the registerAgentWebhook() round-trip entirely.
    // Re-registering generates a NEW secret on AgentPhone's side, racing
    // against any in-flight delivery and leaving one side with a stale
    // secret — which is what was 401-ing every turn.
    _shared = {
      agentId: env.sharedAgentId,
      numberId: env.sharedNumberId ?? null,
      phoneNumber: env.lassoPhoneNumber ?? null,
      webhookSecret: env.sharedWebhookSecret ?? null,
    };
    console.log(
      `[lasso] shared-agent: using env-configured agent=${_shared.agentId} number=${_shared.phoneNumber ?? "none"} secret=${env.sharedWebhookSecret ? "pinned" : "will-register"}`,
    );

    // Only call registerAgentWebhook if we DON'T have a pinned secret.
    if (!env.sharedWebhookSecret && env.publicUrl?.startsWith("https://")) {
      const ap = getAgentPhone();
      const webhookUrl = `${env.publicUrl}/webhooks/agentphone-turn`;
      ap.registerAgentWebhook(_shared.agentId, { url: webhookUrl, contextLimit: 10 })
        .then((wh) => {
          _shared!.webhookSecret = wh.secret;
          console.log(
            `[lasso] shared-agent: webhook registered at ${webhookUrl} — set LASSO_SHARED_WEBHOOK_SECRET=${wh.secret} on Railway to make this stable across reboots`,
          );
        })
        .catch((err) => {
          console.warn("[lasso] shared-agent: webhook registration failed (continuing)", err);
        });
    }

    return _shared;
  }

  const ap = getAgentPhone();

  // 1. Find an existing agent named SHARED_AGENT_NAME, else create one in webhook mode
  let agent: AgentResponse | null = null;
  try {
    const existing = await ap.listAgents();
    agent = existing.find((a) => a.name === SHARED_AGENT_NAME) ?? null;
  } catch (err) {
    console.warn("[lasso] shared-agent: listAgents failed (will try createAgent)", err);
  }

  if (!agent) {
    console.log("[lasso] shared-agent: creating new webhook-mode agent");
    agent = await ap.createAgent({
      name: SHARED_AGENT_NAME,
      voiceMode: "webhook",
      modelTier: "balanced",
      sttMode: "fast",
      beginMessage: "Hey! Quick call about your checkout — got a sec?",
      // Webhook mode doesn't use systemPrompt at agent level — our webhook
      // returns each turn's response. But the API may still require it as a
      // placeholder; keep it short.
      systemPrompt: "You are a Lasso recovery-call agent. Your responses are driven by the configured webhook.",
    });
  } else {
    console.log(`[lasso] shared-agent: reusing existing agent ${agent.id}`);
  }

  // 2. Find or attach a phone number
  let numberId: string | null = null;
  let phoneNumber: string | null = null;
  try {
    const allNumbers = await ap.listNumbers();
    // Already-attached to this agent? Use that.
    const ours = allNumbers.find((n) => n.agentId === agent!.id);
    if (ours) {
      numberId = ours.id;
      phoneNumber = ours.phoneNumber;
    } else {
      // Find an unattached SMS-capable number
      const free = allNumbers.find((n) => !n.agentId && n.type === "sms") ?? allNumbers.find((n) => !n.agentId);
      if (free) {
        await ap.attachNumber(agent.id, free.id);
        numberId = free.id;
        phoneNumber = free.phoneNumber;
      } else {
        const num = await ap.provisionNumber();
        await ap.attachNumber(agent.id, num.id);
        numberId = num.id;
        phoneNumber = num.phoneNumber;
      }
    }
  } catch (err) {
    console.warn("[lasso] shared-agent: number setup failed (continuing)", err);
  }

  // 3. Register the webhook (if we have a public URL)
  let webhookSecret: string | null = null;
  if (env.publicUrl && env.publicUrl.startsWith("https://")) {
    const webhookUrl = `${env.publicUrl}/webhooks/agentphone-turn`;
    try {
      const wh = await ap.registerAgentWebhook(agent.id, { url: webhookUrl, contextLimit: 10 });
      webhookSecret = wh.secret;
      console.log(`[lasso] shared-agent: webhook registered at ${webhookUrl}`);
    } catch (err) {
      console.warn("[lasso] shared-agent: webhook registration failed", err);
    }
  } else {
    console.warn(
      `[lasso] shared-agent: PUBLIC_URL is not https (${env.publicUrl}) — skipping webhook registration. ` +
        `Run 'ngrok http 3001', set PUBLIC_URL=https://your-ngrok-url, and restart.`
    );
  }

  _shared = {
    agentId: agent.id,
    numberId,
    phoneNumber,
    webhookSecret,
  };

  console.log(
    `[lasso] shared-agent: ready (agent=${_shared.agentId}, number=${_shared.phoneNumber ?? "none"}, webhook=${_shared.webhookSecret ? "registered" : "not-registered"})`
  );

  return _shared;
}
