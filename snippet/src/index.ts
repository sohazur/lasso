/**
 * Lasso snippet — the one-line script.
 *
 * Boot path:
 *   1. Read merchant_id from <script data-merchant="...">
 *   2. Detect if this page is a checkout (heuristics)
 *   3. If yes: attach form watcher, log snapshot deltas
 *      (consent banner, exit-intent, event sender wire in next)
 */

import { detectCheckout } from "./checkout-detector.js";
import { startWatcher, type CheckoutSnapshot } from "./form-watcher.js";

type LassoConfig = {
  merchantId: string;
  serverUrl: string;
};

function readConfig(): LassoConfig | null {
  const script = document.currentScript as HTMLScriptElement | null;
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

  startWatcher(detection.platform, (snap: CheckoutSnapshot) => {
    console.log("[lasso] snapshot:", {
      phone: snap.phone,
      email: snap.email,
      name: snap.name,
      cart: snap.cart_lines.length,
      total_cents: snap.cart_total_cents,
    });
  });

  // TODO: consent-banner.ts — slide-in opt-in UI
  // TODO: exit-intent.ts — mouse-toward-chrome + idle + visibility triggers
  // TODO: client.ts — POST /checkout-event via sendBeacon
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
