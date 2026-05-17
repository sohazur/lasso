/**
 * Sends abandonment events to the Lasso server.
 *
 * Uses navigator.sendBeacon when available (survives tab close).
 * Falls back to fetch with keepalive: true.
 */

import type { CheckoutSnapshot } from "./form-watcher.js";
import type { AbandonTrigger } from "./exit-intent.js";

export type CheckoutEventPayload = {
  merchant_id: string;
  trigger: AbandonTrigger;
  snapshot: CheckoutSnapshot;
  page_url: string;
  user_agent: string;
  fired_at: number;
};

export function sendCheckoutEvent(
  serverUrl: string,
  merchantId: string,
  trigger: AbandonTrigger,
  snapshot: CheckoutSnapshot
): boolean {
  const payload: CheckoutEventPayload = {
    merchant_id: merchantId,
    trigger,
    snapshot,
    page_url: window.location.href,
    user_agent: navigator.userAgent,
    fired_at: Date.now(),
  };
  const url = `${serverUrl.replace(/\/$/, "")}/checkout-event`;
  const body = JSON.stringify(payload);

  // sendBeacon is the only thing that reliably survives unload
  if (typeof navigator.sendBeacon === "function") {
    try {
      const blob = new Blob([body], { type: "application/json" });
      const ok = navigator.sendBeacon(url, blob);
      if (ok) return true;
    } catch { /* fall through to fetch */ }
  }

  // Fallback: fetch keepalive (works on modern browsers even during unload)
  try {
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
      mode: "cors",
    }).catch(() => { /* swallow — fire and forget */ });
    return true;
  } catch {
    return false;
  }
}
