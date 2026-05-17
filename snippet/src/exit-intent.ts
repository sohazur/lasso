/**
 * Abandonment triggers.
 *
 * Four signals:
 *   - exit_intent: mouse leaves viewport at the top edge
 *   - tab_hidden:  visibilitychange → hidden, then no return within HIDDEN_GRACE_MS
 *   - page_hide:   pagehide fires when the tab is actually closing or navigating
 *                  away. Fires immediately — no grace window possible.
 *   - idle:        no user input for IDLE_MS after first phone capture
 *
 * Fires once per page load. Guards: valid phone, cart_total over threshold.
 */

import type { CheckoutSnapshot } from "./form-watcher.js";

// Demo timings — fast on stage. Real product would use longer windows.
const HIDDEN_GRACE_MS = 4000;
const IDLE_MS = 60_000;
const MIN_CART_TOTAL_CENTS = 1000;

export type AbandonTrigger = "exit_intent" | "idle" | "tab_hidden" | "page_hide" | "manual";

export type ExitIntentHandle = {
  fire: (trigger?: AbandonTrigger) => void;
  stop: () => void;
};

export function startAbandonmentWatch(
  getSnapshot: () => CheckoutSnapshot,
  onAbandon: (trigger: AbandonTrigger, snap: CheckoutSnapshot) => void
): ExitIntentHandle {
  let fired = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let hiddenTimer: ReturnType<typeof setTimeout> | undefined;

  function attemptFire(trigger: AbandonTrigger): void {
    if (fired) return;
    const snap = getSnapshot();
    if (!isFireable(snap, trigger)) return;
    fired = true;
    teardown();
    onAbandon(trigger, snap);
  }

  function isFireable(snap: CheckoutSnapshot, trigger: AbandonTrigger): boolean {
    if (trigger === "manual") return true; // bypass guards for manual escape hatch
    if (!snap.phone || !looksLikePhone(snap.phone)) return false;
    if (typeof snap.cart_total_cents === "number" && snap.cart_total_cents < MIN_CART_TOTAL_CENTS) return false;
    return true;
  }

  // Exit intent — mouse leaves at top edge moving upward
  function onMouseOut(e: MouseEvent): void {
    if (e.clientY <= 0 && e.relatedTarget === null) {
      attemptFire("exit_intent");
    }
  }

  // Tab hidden — give a short grace window before firing
  function onVisibilityChange(): void {
    if (document.visibilityState === "hidden") {
      hiddenTimer = setTimeout(() => attemptFire("tab_hidden"), HIDDEN_GRACE_MS);
    } else if (hiddenTimer) {
      clearTimeout(hiddenTimer);
      hiddenTimer = undefined;
    }
  }

  // Page hide — fires when the tab is actually closing or navigating away.
  // This is our only reliable signal for "tab closed". No grace window possible:
  // by the time pagehide fires, we have milliseconds before the page is destroyed.
  // sendCheckoutEvent uses navigator.sendBeacon which survives unload.
  function onPageHide(): void {
    attemptFire("page_hide");
  }

  // Idle — reset on any activity; start counting once we have a phone number
  let idleArmed = false;
  function armIdleIfReady(): void {
    if (idleArmed) return;
    const snap = getSnapshot();
    if (snap.phone && looksLikePhone(snap.phone)) {
      idleArmed = true;
      resetIdle();
    }
  }
  function resetIdle(): void {
    if (idleTimer) clearTimeout(idleTimer);
    if (!idleArmed) return;
    idleTimer = setTimeout(() => attemptFire("idle"), IDLE_MS);
  }
  function onActivity(): void {
    armIdleIfReady();
    resetIdle();
  }

  document.addEventListener("mouseout", onMouseOut);
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("pagehide", onPageHide);
  document.addEventListener("input", onActivity, { passive: true });
  document.addEventListener("mousemove", onActivity, { passive: true });
  document.addEventListener("scroll", onActivity, { passive: true });
  document.addEventListener("keydown", onActivity, { passive: true });

  function teardown(): void {
    document.removeEventListener("mouseout", onMouseOut);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("pagehide", onPageHide);
    document.removeEventListener("input", onActivity);
    document.removeEventListener("mousemove", onActivity);
    document.removeEventListener("scroll", onActivity);
    document.removeEventListener("keydown", onActivity);
    if (idleTimer) clearTimeout(idleTimer);
    if (hiddenTimer) clearTimeout(hiddenTimer);
  }

  return {
    fire: (trigger: AbandonTrigger = "manual") => attemptFire(trigger),
    stop: teardown,
  };
}

// E.164-ish: digits and optional leading + and separators. Tolerant on purpose.
const PHONE_DIGITS_RE = /\d/g;
function looksLikePhone(s: string): boolean {
  const digits = (s.match(PHONE_DIGITS_RE) ?? []).length;
  return digits >= 7;
}
