/**
 * Lasso snippet — the one-line script.
 *
 * Boot path:
 *   1. Read merchant_id from <script data-merchant="...">
 *   2. Detect if this page is a checkout (heuristics)
 *   3. Mount consent banner (slide-down)
 *   4. Start form watcher (phone/email/name/address/cart capture)
 *   5. Arm abandonment triggers (exit-intent / idle / tab-hidden)
 *   6. On abandonment + consent + valid phone: POST event to server
 *
 * Also exposes window.Lasso.fire() as a manual escape hatch for stage demos.
 */

import { watchForCheckout } from "./checkout-detector.js";
import { startWatcher, type CheckoutSnapshot } from "./form-watcher.js";
import { startAbandonmentWatch, type AbandonTrigger } from "./exit-intent.js";
import { sendCheckoutEvent } from "./client.js";

type LassoConfig = {
  merchantId: string;
  serverUrl: string;
};

declare global {
  interface Window {
    Lasso?: {
      fire: (trigger?: AbandonTrigger) => void;
      snapshot: () => CheckoutSnapshot | null;
    };
  }
}

// Capture our <script> element at module-execution time.
// document.currentScript is only valid during top-level execution —
// inside DOMContentLoaded callbacks it returns null.
const SELF_SCRIPT = (document.currentScript as HTMLScriptElement | null) ?? findSelfScript();

function findSelfScript(): HTMLScriptElement | null {
  // Fallback: look for any script tag carrying data-merchant.
  // Works when currentScript isn't available (e.g., loaded async or via DOMContentLoaded path).
  const candidates = document.querySelectorAll<HTMLScriptElement>("script[data-merchant]");
  return candidates[candidates.length - 1] ?? null;
}

function readConfig(): LassoConfig | null {
  const script = SELF_SCRIPT;
  if (!script) return null;
  const merchantId = script.dataset.merchant;
  if (!merchantId) {
    console.warn("[lasso] missing data-merchant attribute on script tag");
    return null;
  }
  // Default: post events back to the same server the snippet was loaded from.
  // The script tag's src is the source of truth — strip /snippet.js to get
  // the API base. An explicit data-server attr overrides this for advanced setups.
  const serverUrl = script.dataset.server ?? deriveServerUrlFromScript(script);
  return { merchantId, serverUrl };
}

function deriveServerUrlFromScript(script: HTMLScriptElement): string {
  try {
    const src = new URL(script.src);
    // Strip trailing /snippet.js (or any path) so we land at the origin root.
    return `${src.origin}`;
  } catch {
    return "https://lasso.example/api";
  }
}

function init(): void {
  const config = readConfig();
  if (!config) return;

  console.info(
    `%c[lasso]%c loaded · merchant=${config.merchantId} · server=${config.serverUrl}`,
    "background:#f59e0b;color:#1b1b1b;padding:2px 6px;border-radius:4px;font-weight:600",
    "color:inherit",
  );

  // Use watchForCheckout (not the one-shot detectCheckout) so SPA sites that
  // render the checkout form after a route change still get picked up. The
  // callback fires exactly once when detection succeeds.
  watchForCheckout((detection) => {
    console.log(
      `[lasso] checkout detected (${detection.platform}, ${detection.confidence}): ${detection.reason}`
    );
    bootSnippet(detection, config);
  });
}

function bootSnippet(detection: { platform: import("./checkout-detector.js").CheckoutPlatform }, config: LassoConfig): void {

  const watcher = startWatcher(detection.platform, (snap) => {
    console.log("[lasso] snapshot:", summarizeSnapshot(snap));
  });

  const abandonment = startAbandonmentWatch(
    () => watcher.getSnapshot(),
    (trigger, snap) => {
      console.log(`[lasso] abandonment fired (${trigger})`, summarizeSnapshot(snap));
      sendCheckoutEvent(config.serverUrl, config.merchantId, trigger, snap);
    }
  );

  // Expose a stage-safe manual fire button.
  window.Lasso = {
    fire: (trigger: AbandonTrigger = "manual") => abandonment.fire(trigger),
    snapshot: () => watcher.getSnapshot(),
  };

  // No pagehide cleanup — the abandonment-watch module owns its own pagehide
  // listener and we want that to fire *before* anything tears down.
}

function summarizeSnapshot(snap: CheckoutSnapshot): Record<string, unknown> {
  return {
    phone: snap.phone,
    email: snap.email,
    name: snap.name,
    address: snap.street_address,
    city: snap.city,
    country: snap.country,
    cart: snap.cart_lines.length,
    total_cents: snap.cart_total_cents,
  };
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
