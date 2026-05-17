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

  // Use text/plain so the request is a "simple" CORS request — no preflight.
  // Why this matters: sendBeacon and fetch-with-keepalive during unload both
  // silently fail if the browser needs to do a preflight first. The server
  // route parses the body as JSON regardless of Content-Type.
  const contentType = "text/plain;charset=UTF-8";

  if (typeof navigator.sendBeacon === "function") {
    try {
      const blob = new Blob([body], { type: contentType });
      const ok = navigator.sendBeacon(url, blob);
      console.log("[lasso] sendCheckoutEvent → sendBeacon ok=", ok);
      if (ok) return true;
    } catch (err) {
      console.warn("[lasso] sendBeacon threw, falling back to fetch", err);
    }
  }

  try {
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body,
      keepalive: true,
      mode: "cors",
    })
      .then((r) => console.log("[lasso] sendCheckoutEvent → fetch status=", r.status))
      .catch((err) => console.warn("[lasso] sendCheckoutEvent fetch error", err));
    return true;
  } catch (err) {
    console.error("[lasso] sendCheckoutEvent fatal", err);
    return false;
  }
}
