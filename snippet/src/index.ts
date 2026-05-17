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

import { detectCheckout } from "./checkout-detector.js";
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
  const serverUrl = script.dataset.server ?? "https://lasso.example/api";
  return { merchantId, serverUrl };
}

function init(): void {
  const config = readConfig();
  if (!config) return;

  const detection = detectCheckout();
  if (!detection.isCheckout) {
    console.debug("[lasso] not a checkout page, standing down");
    return;
  }

  console.log(
    `[lasso] checkout detected (${detection.platform}, ${detection.confidence}): ${detection.reason}`
  );

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
