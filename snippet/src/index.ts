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
import { mountConsentBanner } from "./consent-banner.js";
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
  // DEBUG: visible heartbeat so we know the script booted, independent of console
  paintHeartbeat("loading");

  const config = readConfig();
  if (!config) {
    paintHeartbeat("no-config");
    return;
  }

  const detection = detectCheckout();
  if (!detection.isCheckout) {
    paintHeartbeat("not-checkout");
    console.debug("[lasso] not a checkout page, standing down");
    return;
  }

  paintHeartbeat("checkout-detected");
  console.log(
    `[lasso] checkout detected (${detection.platform}, ${detection.confidence}): ${detection.reason}`
  );

  const watcher = startWatcher(detection.platform, (snap) => {
    console.log("[lasso] snapshot:", summarizeSnapshot(snap));
  });

  const consent = mountConsentBanner(watcher.getSnapshot().store_name, (consented) => {
    const snap = watcher.getSnapshot();
    snap.consent_given = consented;
    console.log("[lasso] consent:", consented);
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

  // Cleanup if the page is unloaded normally (best effort)
  window.addEventListener("pagehide", () => {
    consent.destroy();
    watcher.stop();
    abandonment.stop();
  }, { once: true });
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
    consent: snap.consent_given,
  };
}

function paintHeartbeat(state: string): void {
  const id = "lasso-heartbeat";
  let dot = document.getElementById(id);
  if (!dot) {
    dot = document.createElement("div");
    dot.id = id;
    dot.style.cssText =
      "position:fixed;top:8px;right:8px;z-index:2147483647;padding:6px 10px;font:11px/1.2 ui-monospace,Menlo,monospace;background:#000;color:#fff;border-radius:4px;pointer-events:none;";
    document.body?.appendChild(dot);
  }
  dot.textContent = `lasso: ${state}`;
  dot.style.background =
    state === "checkout-detected" ? "#16a34a" : state === "loading" ? "#0ea5e9" : "#dc2626";
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
