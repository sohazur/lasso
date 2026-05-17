/**
 * Lasso snippet — the one-line script.
 *
 * Boot path:
 *   1. Read merchant_id from <script data-merchant="...">
 *   2. Detect if this page is a checkout (heuristics)
 *   3. If yes: render consent banner, attach form watcher + abandonment triggers
 *   4. On abandonment + consent + valid phone: POST event to backend
 */

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

  // TODO: checkout-detector.ts — heuristics for is-checkout-page
  // TODO: consent-banner.ts — slide-in opt-in UI
  // TODO: form-watcher.ts — capture phone/email/cart deltas
  // TODO: exit-intent.ts — mouse-toward-chrome + idle + visibility triggers
  // TODO: client.ts — POST /checkout-event via sendBeacon

  console.log("[lasso] initialized for merchant:", config.merchantId);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
