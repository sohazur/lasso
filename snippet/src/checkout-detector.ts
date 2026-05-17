/**
 * Detects whether the current page is a checkout page.
 *
 * Returns the first positive match from a priority-ordered heuristic stack.
 * If no heuristic trips, the snippet stays silent (no banner, no listeners).
 *
 * The detector is conservative: false positives are worse than false negatives
 * (we'd be capturing PII on a non-checkout page). But it's also pragmatic —
 * many real checkouts skip standard autocomplete attrs, so we fall back to
 * field names + signals from common payment libraries.
 */

export type CheckoutPlatform =
  | "shopify"
  | "woocommerce"
  | "stripe_checkout"
  | "stripe_elements"
  | "square"
  | "generic"
  | null;

export type CheckoutDetection = {
  isCheckout: boolean;
  platform: CheckoutPlatform;
  confidence: "definite" | "high" | "medium" | "low";
  reason: string;
};

type ShopifyGlobal = { Checkout?: unknown };
type WindowWithPlatforms = Window & {
  Shopify?: ShopifyGlobal;
  WooCommerce?: unknown;
  Stripe?: unknown;
  Square?: unknown;
  SqPaymentForm?: unknown;
};

const NEGATIVE: CheckoutDetection = {
  isCheckout: false,
  platform: null,
  confidence: "low",
  reason: "no heuristic matched",
};

const PATH_PATTERNS = [
  /\/(checkout|checkouts)(\/|$|\?)/i,
  /\/(cart|basket)\/(checkout|pay|payment)/i,
  /\/(pay|payment|purchase|order|orders)\/(new|create)/i,
  /\/billing(\/|$)/i,
];

const PAY_BUTTON_PATTERNS = /\b(pay|checkout|purchase|complete\s*order|place\s*order|buy\s*now|confirm\s*order|submit\s*order|continue\s*to\s*payment|complete\s*purchase)\b/i;

export function detectCheckout(): CheckoutDetection {
  if (typeof window === "undefined" || typeof document === "undefined") return NEGATIVE;

  const w = window as WindowWithPlatforms;
  const path = window.location.pathname.toLowerCase();
  const host = window.location.hostname.toLowerCase();

  // 1. Stripe-hosted checkout — definite by hostname
  if (host === "checkout.stripe.com" || host.endsWith(".checkout.stripe.com")) {
    return { isCheckout: true, platform: "stripe_checkout", confidence: "definite", reason: "stripe checkout hostname" };
  }

  // 2. Shopify Checkout global — definite
  if (w.Shopify && typeof w.Shopify === "object" && "Checkout" in w.Shopify) {
    return { isCheckout: true, platform: "shopify", confidence: "definite", reason: "window.Shopify.Checkout present" };
  }

  // 3. Stripe Elements embedded in the page — definite
  if (hasStripeElements()) {
    return { isCheckout: true, platform: "stripe_elements", confidence: "definite", reason: "Stripe Elements iframe present" };
  }

  // 4. Square Web Payments SDK — definite
  if (w.Square || w.SqPaymentForm || document.querySelector('iframe[src*="square"]')) {
    return { isCheckout: true, platform: "square", confidence: "definite", reason: "Square payment SDK present" };
  }

  // 5. Credit-card autocomplete field present — definite
  if (document.querySelector('input[autocomplete="cc-number"]')) {
    return { isCheckout: true, platform: detectPlatformFromDOM(), confidence: "definite", reason: "cc-number input present" };
  }

  // 6. URL pathname patterns — high
  const matchedPattern = PATH_PATTERNS.find((re) => re.test(path));
  if (matchedPattern) {
    return { isCheckout: true, platform: detectPlatformFromDOM(), confidence: "high", reason: `pathname matches ${matchedPattern}` };
  }

  // 7. Form-shaped detection — high if strict, medium if loose
  const formMatch = findCheckoutShapedForm();
  if (formMatch) {
    return {
      isCheckout: true,
      platform: detectPlatformFromDOM(),
      confidence: formMatch.confidence,
      reason: formMatch.reason,
    };
  }

  // 8. WooCommerce on a cart/checkout-ish path — medium
  if (w.WooCommerce && (path.includes("/checkout") || path.includes("/cart"))) {
    return { isCheckout: true, platform: "woocommerce", confidence: "medium", reason: "WooCommerce global + cart/checkout path" };
  }

  return NEGATIVE;
}

function detectPlatformFromDOM(): CheckoutPlatform {
  const w = window as WindowWithPlatforms;
  if (w.Shopify) return "shopify";
  if (w.WooCommerce) return "woocommerce";
  if (window.location.hostname.endsWith("checkout.stripe.com")) return "stripe_checkout";
  if (hasStripeElements()) return "stripe_elements";
  if (w.Square || w.SqPaymentForm) return "square";
  return "generic";
}

function hasStripeElements(): boolean {
  // Stripe Elements injects an iframe whose src points at js.stripe.com
  const frames = document.querySelectorAll('iframe[src*="js.stripe.com"], iframe[name*="__privateStripe"]');
  return frames.length > 0;
}

type FormMatch = { confidence: "high" | "medium"; reason: string };

function findCheckoutShapedForm(): FormMatch | null {
  const forms = Array.from(document.querySelectorAll("form"));

  // Strict pass — tel + email + pay-shaped button
  for (const form of forms) {
    if (!hasPhoneInput(form) || !hasEmailInput(form)) continue;
    if (hasPayLikeSubmit(form)) {
      return { confidence: "high", reason: "form has tel + email + pay-like submit" };
    }
  }

  // Loose pass — tel + email + ANY submit; relies on URL or other signals to filter
  for (const form of forms) {
    if (!hasPhoneInput(form) || !hasEmailInput(form)) continue;
    if (form.querySelector('button[type="submit"], button:not([type]), input[type="submit"]')) {
      return { confidence: "medium", reason: "form has tel + email + submit (no pay-like text)" };
    }
  }

  return null;
}

function hasPhoneInput(scope: ParentNode): boolean {
  // First try standard selectors
  if (scope.querySelector('input[type="tel"], input[autocomplete*="tel"]')) return true;
  // Fallback: inputs whose name/id/placeholder/aria-label looks phone-y
  const inputs = scope.querySelectorAll<HTMLInputElement>("input");
  for (const input of inputs) {
    const sig = `${input.name} ${input.id} ${input.placeholder} ${input.getAttribute("aria-label") ?? ""}`.toLowerCase();
    if (/\b(phone|mobile|tel|cell)\b/.test(sig)) return true;
  }
  return false;
}

function hasEmailInput(scope: ParentNode): boolean {
  if (scope.querySelector('input[type="email"], input[autocomplete*="email"]')) return true;
  const inputs = scope.querySelectorAll<HTMLInputElement>("input");
  for (const input of inputs) {
    const sig = `${input.name} ${input.id} ${input.placeholder} ${input.getAttribute("aria-label") ?? ""}`.toLowerCase();
    if (/\bemail\b/.test(sig) || /e-?mail/.test(sig)) return true;
  }
  return false;
}

function hasPayLikeSubmit(scope: ParentNode): boolean {
  const submits = scope.querySelectorAll<HTMLElement>(
    'button[type="submit"], button:not([type]), input[type="submit"]'
  );
  for (const btn of submits) {
    const text = ((btn as HTMLInputElement).value || btn.innerText || btn.textContent || "").trim();
    if (PAY_BUTTON_PATTERNS.test(text)) return true;
    // Also check aria-label
    const aria = btn.getAttribute("aria-label") ?? "";
    if (aria && PAY_BUTTON_PATTERNS.test(aria)) return true;
  }
  return false;
}

/**
 * Set up a watcher that re-runs detection whenever the DOM changes meaningfully.
 * Useful for SPA checkouts where the form is rendered after route changes.
 * Returns a cleanup function.
 */
export function watchForCheckout(onDetected: (detection: CheckoutDetection) => void): () => void {
  let fired = false;
  let scheduled = false;

  function check(): void {
    if (fired) return;
    scheduled = false;
    const detection = detectCheckout();
    if (detection.isCheckout) {
      fired = true;
      observer.disconnect();
      window.removeEventListener("popstate", schedule);
      window.removeEventListener("pushstate", schedule);
      onDetected(detection);
    }
  }

  function schedule(): void {
    if (scheduled || fired) return;
    scheduled = true;
    setTimeout(check, 250);
  }

  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // SPA navigation often uses history.pushState, which doesn't fire popstate.
  // Monkey-patch pushState to emit a synthetic event so we can catch it.
  const originalPush = window.history.pushState;
  window.history.pushState = function (...args: Parameters<typeof originalPush>) {
    const result = originalPush.apply(this, args);
    window.dispatchEvent(new Event("pushstate"));
    return result;
  };
  window.addEventListener("popstate", schedule);
  window.addEventListener("pushstate", schedule);

  // Initial check
  check();

  return () => {
    observer.disconnect();
    window.removeEventListener("popstate", schedule);
    window.removeEventListener("pushstate", schedule);
    window.history.pushState = originalPush;
  };
}
