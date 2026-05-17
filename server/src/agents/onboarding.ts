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

  // Step 5: atomic-swap chunks into Moss. Moss is the only home for chunks —
  // it's what the in-call lookup_store tool queries. Supermemory holds only
  // the LLM-generated context, private notes, and (post-call) per-caller memory.
  const indexName = `merchant_${merchantId}`;

  try {
    await getMoss().createIndex(
      indexName,
      chunks.map((c) => ({
        id: c.id,
        text: c.text,
        metadata: { pageUrl: c.pageUrl, pageTitle: c.pageTitle, sectionTitle: c.sectionTitle },
      }))
    );
  } catch (err) {
    console.error(`[lasso] onboarding ${merchantId}: Moss indexing failed`, err);
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

  // Step 7: ready (AgentPhone resources are now shared, provisioned at server boot)
  await db.updateMerchant(merchantId, { status: "ready", failed_step: null });
  console.log(`[lasso] onboarding ${merchantId}: ready`);
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
