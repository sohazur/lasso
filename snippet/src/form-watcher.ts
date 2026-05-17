/**
 * Watches the checkout form for phone/email/name input and the cart line items.
 *
 * Maintains an in-memory CheckoutSnapshot that the rest of the snippet
 * (consent banner, exit-intent, event sender) reads from.
 */

import type { CheckoutPlatform } from "./checkout-detector.js";

export type CartLine = {
  title?: string;
  qty?: number;
  price_cents?: number;
};

export type CheckoutSnapshot = {
  phone?: string;
  email?: string;
  name?: string;
  street_address?: string;
  city?: string;
  state?: string;
  postal_code?: string;
  country?: string;
  cart_lines: CartLine[];
  cart_total_cents?: number;
  store_url: string;
  store_name?: string;
  detected_platform: CheckoutPlatform;
  page_entered_at: number;
};

const DEBOUNCE_MS = 250;

export type WatcherHandle = {
  getSnapshot: () => CheckoutSnapshot;
  stop: () => void;
};

export function startWatcher(platform: CheckoutPlatform, onUpdate?: (snap: CheckoutSnapshot) => void): WatcherHandle {
  const snapshot: CheckoutSnapshot = {
    cart_lines: [],
    store_url: window.location.origin,
    store_name: readStoreName() ?? undefined,
    detected_platform: platform,
    page_entered_at: Date.now(),
  };

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  function publish(): void {
    if (onUpdate) onUpdate(snapshot);
  }

  function readFormState(): void {
    snapshot.phone = readInputValue([
      'input[autocomplete="tel"]',
      'input[autocomplete="tel-national"]',
      'input[type="tel"]',
    ]);
    snapshot.email = readInputValue([
      'input[autocomplete="email"]',
      'input[type="email"]',
    ]);
    snapshot.name = readName();
    snapshot.street_address = readInputValue([
      'input[autocomplete="street-address"]',
      'input[autocomplete="address-line1"]',
    ]);
    snapshot.city = readInputValue(['input[autocomplete="address-level2"]']);
    snapshot.state = readInputValue(['input[autocomplete="address-level1"]']);
    snapshot.postal_code = readInputValue([
      'input[autocomplete="postal-code"]',
      'input[autocomplete="zip"]',
    ]);
    snapshot.country = readInputValue([
      'input[autocomplete="country-name"]',
      'input[autocomplete="country"]',
      'select[autocomplete="country"]',
    ]);
    const cart = readCart(platform);
    snapshot.cart_lines = cart.lines;
    snapshot.cart_total_cents = cart.total_cents;
    publish();
  }

  function onChange(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(readFormState, DEBOUNCE_MS);
  }

  document.addEventListener("input", onChange, { passive: true });
  document.addEventListener("change", onChange, { passive: true });

  // Initial read in case fields are pre-filled
  readFormState();

  return {
    getSnapshot: () => snapshot,
    stop: () => {
      document.removeEventListener("input", onChange);
      document.removeEventListener("change", onChange);
      if (debounceTimer) clearTimeout(debounceTimer);
    },
  };
}

function readInputValue(selectors: string[]): string | undefined {
  for (const sel of selectors) {
    const el = document.querySelector<HTMLInputElement>(sel);
    const value = el?.value?.trim();
    if (value) return value;
  }
  return undefined;
}

function readName(): string | undefined {
  const full = readInputValue(['input[autocomplete="name"]']);
  if (full) return full;
  const given = readInputValue(['input[autocomplete="given-name"]']);
  const family = readInputValue(['input[autocomplete="family-name"]']);
  if (given || family) return [given, family].filter(Boolean).join(" ").trim() || undefined;
  return undefined;
}

function readStoreName(): string | null {
  const og = document.querySelector<HTMLMetaElement>('meta[property="og:site_name"]')?.content?.trim();
  if (og) return og;
  const title = document.title?.split(/[—|·\-–]/)?.[0]?.trim();
  return title || null;
}

type CartReadResult = { lines: CartLine[]; total_cents?: number };

function readCart(platform: CheckoutPlatform): CartReadResult {
  switch (platform) {
    case "shopify":
      return readShopifyCart();
    case "woocommerce":
      return readWooCart();
    case "stripe_checkout":
      return readStripeCart();
    default:
      return readGenericCart();
  }
}

type ShopifyLineItem = { title?: string; quantity?: number; line_price?: number };

function readShopifyCart(): CartReadResult {
  const w = window as unknown as { Shopify?: { Checkout?: { lineItems?: ShopifyLineItem[]; totalPrice?: number } } };
  const co = w.Shopify?.Checkout;
  if (co?.lineItems && Array.isArray(co.lineItems)) {
    return {
      lines: co.lineItems.map((li) => ({
        title: li.title,
        qty: li.quantity,
        price_cents: li.line_price,
      })),
      total_cents: typeof co.totalPrice === "number" ? co.totalPrice : undefined,
    };
  }
  return readGenericCart();
}

function readWooCart(): CartReadResult {
  const rows = document.querySelectorAll(".woocommerce-checkout-review-order-table tr.cart_item");
  const lines: CartLine[] = [];
  rows.forEach((row) => {
    const title = row.querySelector(".product-name")?.textContent?.trim();
    const priceText = row.querySelector(".product-total")?.textContent?.trim();
    lines.push({ title, price_cents: priceText ? parsePriceCents(priceText) : undefined });
  });
  const totalText = document.querySelector(".order-total .amount")?.textContent?.trim();
  return { lines, total_cents: totalText ? parsePriceCents(totalText) : undefined };
}

function readStripeCart(): CartReadResult {
  const els = document.querySelectorAll('[data-testid="product-summary"] [data-testid*="line"]');
  const lines: CartLine[] = [];
  els.forEach((el) => {
    const text = el.textContent?.trim();
    if (text) lines.push({ title: text });
  });
  return { lines };
}

function readGenericCart(): CartReadResult {
  // Heuristic: any element with class containing "line-item" or "cart-item"
  const els = document.querySelectorAll('[class*="line-item"], [class*="cart-item"], [class*="lineItem"]');
  const lines: CartLine[] = [];
  els.forEach((el) => {
    const title = el.querySelector('[class*="title"], [class*="name"], h2, h3, h4')?.textContent?.trim();
    const priceText = el.querySelector('[class*="price"], [class*="amount"]')?.textContent?.trim();
    if (title || priceText) lines.push({ title, price_cents: priceText ? parsePriceCents(priceText) : undefined });
  });
  return { lines };
}

function parsePriceCents(text: string): number | undefined {
  const cleaned = text.replace(/[^\d.,-]/g, "").replace(/,/g, "");
  const n = parseFloat(cleaned);
  if (Number.isNaN(n)) return undefined;
  return Math.round(n * 100);
}
