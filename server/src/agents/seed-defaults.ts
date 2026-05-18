/**
 * On server boot, seed default strategy slots (behavior, brand_brief, playbooks)
 * for known demo merchants. The defaults are the canonical Sarah persona pulled
 * from the strategy-service prototype (saved as files under ./prompts/) so
 * we don't have to maintain ~200 lines of escaped template strings inline.
 *
 * The seed overwrites placeholder content (short manual edits, "test", "todo",
 * "tbd", "xyz"-style fill-in text) so a demo doesn't get stuck with a junky
 * behavior text the user pasted while exploring the UI.
 */

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getStore } from "../clients/supabase.js";

const SEED_MERCHANTS = ["demo", "saaya-netlify-app"];

// Resolve prompt files relative to *this* compiled module. After `tsc`,
// the structure mirrors: server/dist/agents/seed-defaults.js → ../../src/agents/prompts.
// We try a few paths so it works in dev (tsx, src/) and prod (compiled, dist/).
const HERE = dirname(fileURLToPath(import.meta.url));
const PROMPT_CANDIDATES = [
  resolve(HERE, "./prompts"),
  resolve(HERE, "../../src/agents/prompts"),
  resolve(HERE, "../src/agents/prompts"),
  resolve(HERE, "../prompts"),
];

async function loadPrompt(filename: string): Promise<string | null> {
  for (const dir of PROMPT_CANDIDATES) {
    try {
      const path = `${dir}/${filename}`;
      return await readFile(path, "utf8");
    } catch {
      /* try next */
    }
  }
  console.warn(`[lasso] seed: could not load prompt file ${filename} from any of ${PROMPT_CANDIDATES.join(", ")}`);
  return null;
}

/**
 * Decide whether a stored slot looks like junk that should be overwritten
 * by the canonical seed. We're generous about overwriting: short strings,
 * placeholder words, and obvious "todo" markers all count.
 */
function isPlaceholder(content: string | null): boolean {
  if (!content) return true;
  const trimmed = content.trim();
  if (trimmed.length === 0) return true;
  if (trimmed.length < 200) return true; // anything that short isn't a real persona
  const lc = trimmed.toLowerCase();
  if (lc === "test" || lc === "todo" || lc === "tbd") return true;
  // Catch the weak hand-typed Sarah behavior from earlier demos.
  if (lc.includes("xyz") && lc.includes("sarah")) return true;
  return false;
}

async function seedOne(
  merchantId: string,
  prompts: { behavior: string | null; brandBrief: string | null; playbooks: string | null },
): Promise<void> {
  const db = getStore();

  if (prompts.behavior) {
    try {
      const existing = await db.getStrategySlot(merchantId, "behavior");
      if (isPlaceholder(existing)) {
        await db.setStrategySlot(merchantId, "behavior", prompts.behavior);
        console.log(`[lasso] seed: wrote default behavior for ${merchantId} (${prompts.behavior.length} chars)`);
      }
    } catch (err) {
      console.warn(`[lasso] seed: behavior failed for ${merchantId} (continuing)`, err);
    }
  }

  if (prompts.brandBrief) {
    try {
      const existing = await db.getStrategySlot(merchantId, "brand_brief");
      if (isPlaceholder(existing)) {
        await db.setStrategySlot(merchantId, "brand_brief", prompts.brandBrief);
        console.log(`[lasso] seed: wrote default brand_brief for ${merchantId} (${prompts.brandBrief.length} chars)`);
      }
    } catch (err) {
      console.warn(`[lasso] seed: brand_brief failed for ${merchantId} (continuing)`, err);
    }
  }

  if (prompts.playbooks) {
    try {
      const existing = await db.getStrategySlot(merchantId, "playbooks");
      if (isPlaceholder(existing)) {
        await db.setStrategySlot(merchantId, "playbooks", prompts.playbooks);
        console.log(`[lasso] seed: wrote default playbooks for ${merchantId} (${prompts.playbooks.length} chars)`);
      }
    } catch (err) {
      console.warn(`[lasso] seed: playbooks failed for ${merchantId} (continuing)`, err);
    }
  }
}

// Default coupon code we'll add to a merchant's private_context if they
// don't have one set. The agent reads this on every call and may offer it.
const DEFAULT_DISCOUNT_CODE = "LASSO15";

async function ensureCoupon(merchantId: string): Promise<void> {
  const db = getStore();
  try {
    const merchant = await db.getMerchant(merchantId);
    if (!merchant) return;
    const pc = (merchant.private_context ?? {}) as Record<string, unknown>;
    const existing = pc["discount_code"] ?? pc["coupon"] ?? pc["coupon_code"];
    if (typeof existing === "string" && existing.trim().length > 0) return;
    const merged = { ...pc, discount_code: DEFAULT_DISCOUNT_CODE };
    await db.updateMerchant(merchantId, { private_context: merged });
    console.log(`[lasso] seed: set default discount_code=${DEFAULT_DISCOUNT_CODE} for ${merchantId}`);
  } catch (err) {
    console.warn(`[lasso] seed: ensureCoupon failed for ${merchantId} (continuing)`, err);
  }
}

export async function seedDefaultStrategy(): Promise<void> {
  const [behavior, brandBriefSaaya, playbooks] = await Promise.all([
    loadPrompt("sarah-behavior.md"),
    loadPrompt("sarah-brand-saaya.md"),
    loadPrompt("sarah-playbooks.json"),
  ]);

  for (const merchantId of SEED_MERCHANTS) {
    await seedOne(merchantId, {
      behavior,
      brandBrief: brandBriefSaaya,
      playbooks,
    });
    await ensureCoupon(merchantId);
  }
}
