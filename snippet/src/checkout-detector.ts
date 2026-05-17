/**
 * Detects whether the current page is a checkout page.
 *
 * Returns the first positive match from a priority-ordered heuristic stack.
 * If no heuristic trips, the snippet stays silent (no banner, no listeners).
 */

export type CheckoutPlatform = "shopify" | "woocommerce" | "stripe_checkout" | "generic" | null;

export type CheckoutDetection = {
  isCheckout: boolean;
  platform: CheckoutPlatform;
  confidence: "definite" | "high" | "medium";
  reason: string;
};

type ShopifyGlobal = { Checkout?: unknown };
type WindowWithPlatforms = Window & {
  Shopify?: ShopifyGlobal;
  WooCommerce?: unknown;
};

const NEGATIVE: CheckoutDetection = {
  isCheckout: false,
  platform: null,
  confidence: "medium",
  reason: "no heuristic matched",
};

export function detectCheckout(): CheckoutDetection {
  if (typeof window === "undefined" || typeof document === "undefined") return NEGATIVE;

  const w = window as WindowWithPlatforms;
  const path = window.location.pathname.toLowerCase();
  const host = window.location.hostname.toLowerCase();

  // 1. Stripe Checkout — definite by hostname
  if (host === "checkout.stripe.com" || host.endsWith(".checkout.stripe.com")) {
    return { isCheckout: true, platform: "stripe_checkout", confidence: "definite", reason: "stripe checkout hostname" };
  }

  // 2. Shopify Checkout global — definite
  if (w.Shopify && typeof w.Shopify === "object" && "Checkout" in w.Shopify) {
    return { isCheckout: true, platform: "shopify", confidence: "definite", reason: "window.Shopify.Checkout present" };
  }

  // 3. Credit-card field on the page — definite
  if (document.querySelector('input[autocomplete="cc-number"]')) {
    return { isCheckout: true, platform: detectPlatformFromDOM(), confidence: "definite", reason: "cc-number input present" };
  }

  // 4. URL pathname patterns — high
  if (/\/(checkout|checkouts)(\/|$)/.test(path) || path.includes("/cart/checkout")) {
    return { isCheckout: true, platform: detectPlatformFromDOM(), confidence: "high", reason: `pathname matches checkout (${path})` };
  }

  // 5. Form with tel + email + a "pay"-like submit button — high
  if (hasCheckoutShapedForm()) {
    return { isCheckout: true, platform: detectPlatformFromDOM(), confidence: "high", reason: "form has tel + email + pay-like submit" };
  }

  // 6. WooCommerce checkout — medium (global alone isn't enough, but combined with cart path it's a signal)
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
  return "generic";
}

const PAY_BUTTON_PATTERNS = /\b(pay|checkout|purchase|complete\s*order|place\s*order|buy\s*now|confirm\s*order)\b/i;

function hasCheckoutShapedForm(): boolean {
  const forms = document.querySelectorAll("form");
  for (const form of forms) {
    const hasTel = !!form.querySelector('input[type="tel"], input[autocomplete="tel"], input[autocomplete="tel-national"]');
    const hasEmail = !!form.querySelector('input[type="email"], input[autocomplete="email"]');
    if (!hasTel || !hasEmail) continue;

    // Look for a pay-like submit button anywhere in the form
    const submits = form.querySelectorAll('button[type="submit"], button:not([type]), input[type="submit"]');
    for (const btn of submits) {
      const text = ((btn as HTMLElement).innerText || (btn as HTMLInputElement).value || "").trim();
      if (PAY_BUTTON_PATTERNS.test(text)) return true;
    }
  }
  return false;
}
