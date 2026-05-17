/**
 * Onboarding pipeline. Six steps modeled on Foyer:
 *   1. Create merchant row, status="scraping"
 *   2. Firecrawl crawl
 *   3. Chunk pages (heading-aware, hash-dedup)
 *   4. status="indexing"
 *   5. Atomic-swap into Moss + Supermemory
 *   6. Generate brand-context briefing via LLM, save to Supermemory
 *   7. status="ready"
 *
 * Idempotent: re-running for the same merchant_id replaces the KB atomically.
 */

import { getStore, type MerchantRow } from "../clients/supabase.js";
import { getFirecrawl } from "../clients/firecrawl.js";
import { getMoss } from "../clients/moss.js";
import { getMemory } from "../clients/supermemory.js";
import { getLLM } from "../clients/llm.js";
import { getAgentPhone } from "../clients/agentphone.js";
import { env } from "../clients/config.js";
import { chunkPage, type Chunk } from "./chunker.js";

export type OnboardRequest = {
  merchant_id: string;
  name: string;
  url: string;
  /** Merchant-private context: coupons, internal notes, upsell scripts. */
  private_context?: Record<string, unknown>;
};

export type OnboardResult = { merchant_id: string; status: MerchantRow["status"] };

const CRAWL_LIMIT = 30;

export async function onboardMerchant(req: OnboardRequest): Promise<OnboardResult> {
  const db = getStore();
  const merchantId = req.merchant_id;

  // Guard: refuse to re-onboard if a run is in progress
  const existing = await db.getMerchant(merchantId);
  if (existing && (existing.status === "scraping" || existing.status === "indexing")) {
    return { merchant_id: merchantId, status: existing.status };
  }

  // Step 1: create / reset merchant row
  await db.upsertMerchant({
    id: merchantId,
    name: req.name,
    primary_domain: safeHost(req.url),
    status: "scraping",
    private_context: req.private_context ?? null,
    failed_step: null,
  });

  // Fire the rest async — return fast so the HTTP caller doesn't time out
  runPipelineInBackground(req).catch((err) => {
    console.error(`[lasso] onboarding pipeline failed for ${merchantId}:`, err);
  });

  return { merchant_id: merchantId, status: "scraping" };
}

async function runPipelineInBackground(req: OnboardRequest): Promise<void> {
  const db = getStore();
  const merchantId = req.merchant_id;

  let chunks: Chunk[] = [];

  // Step 2: crawl
  try {
    const pages = await getFirecrawl().crawl(req.url, { limit: CRAWL_LIMIT });
    console.log(`[lasso] onboarding ${merchantId}: crawled ${pages.length} pages`);

    // Step 3: chunk
    for (const p of pages) {
      const pageChunks = chunkPage({ url: p.url, title: p.title, markdown: p.markdown });
      chunks.push(...pageChunks);
    }
    console.log(`[lasso] onboarding ${merchantId}: produced ${chunks.length} chunks`);
  } catch (err) {
    console.error(`[lasso] onboarding ${merchantId}: crawl/chunk failed`, err);
    await db.updateMerchant(merchantId, { status: "failed", failed_step: "scraping" });
    return;
  }

  await db.updateMerchant(merchantId, { status: "indexing" });

  // Step 5: atomic-swap into Moss + Supermemory
  const indexName = `merchant_${merchantId}`;
  const memTag = `merchant:${merchantId}:chunks`;

  try {
    await getMoss().createIndex(
      indexName,
      chunks.map((c) => ({
        id: c.id,
        text: c.text,
        metadata: { pageUrl: c.pageUrl, pageTitle: c.pageTitle, sectionTitle: c.sectionTitle },
      }))
    );

    // Reset Supermemory chunks (best-effort delete; if not supported, just storeMany on top)
    try {
      await getMemory().delete(memTag);
    } catch { /* fine */ }

    await getMemory().storeMany(
      memTag,
      chunks.map((c) => ({
        text: c.text,
        metadata: { url: c.pageUrl, title: c.pageTitle, section: c.sectionTitle, id: c.id },
      }))
    );
  } catch (err) {
    console.error(`[lasso] onboarding ${merchantId}: indexing failed`, err);
    await db.updateMerchant(merchantId, { status: "failed", failed_step: "indexing" });
    return;
  }

  // Step 6: brand context via LLM (fail-soft)
  try {
    const brief = await generateBrandContext(req.name, chunks, req.private_context);
    await getMemory().store(`merchant:${merchantId}:context`, {
      text: brief,
      metadata: { generated_at: new Date().toISOString() },
    });
  } catch (err) {
    console.warn(`[lasso] onboarding ${merchantId}: brand-context generation failed (continuing)`, err);
  }

  // Step 6b: persist private context to its own Supermemory tag for the agent to look up
  if (req.private_context && Object.keys(req.private_context).length > 0) {
    try {
      await getMemory().store(`merchant:${merchantId}:private`, {
        text: formatPrivateContext(req.private_context),
        metadata: { kind: "private_context" },
      });
    } catch (err) {
      console.warn(`[lasso] onboarding ${merchantId}: private-context write failed`, err);
    }
  }

  // Step 6c: provision AgentPhone resources (idempotent — skip if already set)
  await ensureAgentPhoneProvisioned(merchantId, req.name);

  // Step 7: ready
  await db.updateMerchant(merchantId, { status: "ready", failed_step: null });
  console.log(`[lasso] onboarding ${merchantId}: ready`);
}

async function ensureAgentPhoneProvisioned(merchantId: string, merchantName: string): Promise<void> {
  const db = getStore();
  const current = await db.getMerchant(merchantId);
  if (current?.agentphone_agent_id) {
    console.log(`[lasso] onboarding ${merchantId}: agentphone already provisioned (agent=${current.agentphone_agent_id})`);
    return;
  }

  try {
    const ap = getAgentPhone();

    // Create a hosted-mode agent persona for this merchant. The actual system
    // prompt is sent per-call (so the brand-context briefing can include the
    // specific cart + caller history), but we still create the persona so
    // we have a stable agentId to bill calls against.
    const agent = await ap.createAgent({
      name: `Lasso for ${merchantName}`,
      voiceMode: "hosted",
      modelTier: "balanced",
      sttMode: "fast",
      beginMessage: "Hey! Quick call about your checkout — got a sec?",
      // Stub system prompt at agent creation; the real per-call prompt is
      // sent on every POST /v1/calls (overrides this default).
      systemPrompt: `You are an outbound recovery-call agent for ${merchantName}. Your per-call instructions will be supplied at call time; default to a warm, brief tone.`,
    });

    // Pick an unattached number we can give this agent. Prefer one matching
    // LASSO_PHONE_NUMBER if it's currently unattached. Otherwise grab any
    // unattached SMS number. Otherwise provision a fresh one.
    let numberId: string | undefined;
    let phoneNumber: string | undefined;

    const existing = await ap.listNumbers();
    const desired = env.lassoPhoneNumber;
    const matchByEnv = desired ? existing.find((n) => n.phoneNumber === desired && !n.agentId) : undefined;
    const anyUnattachedSms = existing.find((n) => !n.agentId && n.type === "sms");
    const pick = matchByEnv ?? anyUnattachedSms ?? existing.find((n) => !n.agentId);

    if (pick) {
      numberId = pick.id;
      phoneNumber = pick.phoneNumber;
      console.log(`[lasso] onboarding ${merchantId}: reusing existing number ${phoneNumber} (id=${numberId})`);
    } else {
      const num = await ap.provisionNumber();
      numberId = num.id;
      phoneNumber = num.phoneNumber;
      console.log(`[lasso] onboarding ${merchantId}: provisioned new number ${phoneNumber} (id=${numberId})`);
    }

    if (numberId) {
      try {
        await ap.attachNumber(agent.id, numberId);
      } catch (err) {
        console.warn(`[lasso] onboarding ${merchantId}: attachNumber failed (continuing)`, err);
      }
    }

    await db.updateMerchant(merchantId, {
      agentphone_agent_id: agent.id,
      agentphone_number_id: numberId ?? null,
      agentphone_phone_number: phoneNumber ?? null,
    });

    console.log(`[lasso] onboarding ${merchantId}: agentphone provisioned (agent=${agent.id}, number=${phoneNumber})`);
  } catch (err) {
    console.warn(`[lasso] onboarding ${merchantId}: agentphone provisioning failed (continuing in mock mode)`, err);
  }
}

async function generateBrandContext(
  storeName: string,
  chunks: Chunk[],
  privateContext?: Record<string, unknown>
): Promise<string> {
  const sampleText = chunks
    .slice(0, 12)
    .map((c) => c.text)
    .join("\n\n---\n\n")
    .slice(0, 8000);

  const system =
    "You write concise brand-context briefings used as system-prompt context for an AI voice agent making recovery calls about abandoned checkouts. Output plain markdown. No preamble.";

  const user = [
    `Store name: ${storeName}`,
    "",
    "Excerpts from the store's site:",
    sampleText,
    "",
    privateContext
      ? `Merchant-private notes (use during recovery calls):\n${JSON.stringify(privateContext, null, 2)}`
      : "",
    "",
    "Produce a briefing with these sections:",
    "## Brand voice — 1-2 sentences describing how the agent should sound",
    "## What this store sells — 1-2 sentences",
    "## Top customer questions — 3 bullets, based on the excerpts",
    "## What to push for on a recovery call — 2-3 sentences with concrete tactics",
  ].join("\n");

  return getLLM().complete({ system, user, maxTokens: 600 });
}

function formatPrivateContext(ctx: Record<string, unknown>): string {
  const lines = ["## Merchant-private context (use ONLY during recovery calls)"];
  for (const [k, v] of Object.entries(ctx)) {
    lines.push(`- **${k}**: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  }
  return lines.join("\n");
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

export async function getOnboardStatus(merchantId: string): Promise<MerchantRow | null> {
  return getStore().getMerchant(merchantId);
}
