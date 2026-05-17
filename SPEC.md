# Lasso — Technical Spec

This is the build-time reference for Lasso. README.md is for judges and merchants; SPEC.md is for us.

---

## 1. End-to-end data flow

```
[Merchant checkout page]
   │
   │  <script src="lasso.js" data-merchant="acme"> </script>
   │
   ▼
[Lasso snippet — vanilla TS, ~15KB]
   │
   ├── on load: detect "is this a checkout page?" (heuristics)
   ├── on detected: render consent banner (slide-in top of page)
   ├── on form change: capture phone/email/cart deltas (debounced)
   ├── on abandonment signal: POST event to server
   │       triggers: exit-intent | 60s idle | tab-visibility hidden 30s
   │
   ▼
[Lasso server — Fastify on Node 20]
   │
   ├── /checkout-event → persist to Supabase, trigger call pipeline
   │
   ├── Call pipeline (async, fire-and-forget):
   │     1. Fetch caller history from Supermemory by {merchantId}:{phone}
   │     2. Kick off site scrape via Firecrawl (cached per merchant)
   │     3. Index scrape into Moss (per-merchant index)
   │     4. Build system prompt: cart + caller_history + store_kb + persona
   │     5. AgentPhone.calls.create({to: phone, prompt, tools})
   │     6. During call: agent uses Moss for store-KB lookups via tool
   │     7. On call end: write transcript + facts to Supermemory
   │     8. On call end: persist outcome to Supabase
   │
   ├── /webhooks/stripe → on payment_intent.succeeded, mark call recovered
   │
   └── /api/calls (read) → for dashboard
   │
   ▼
[Lasso dashboard — Next.js]
   │
   ├── /             → live call log + recovered $ counter (Supabase realtime)
   └── /calls/[id]   → transcript + timeline view
```

---

## 2. The snippet — checkout detection

### How we know "this is a checkout page"

Heuristic stack, in priority order. First positive match wins.

| Signal | Pattern | Confidence |
|---|---|---|
| URL contains `/checkout` or `/cart/checkout` or `/checkouts/` | Pathname regex | High |
| URL matches Stripe Checkout: `checkout.stripe.com` | Hostname | Definite |
| Page has `<form>` with `input[autocomplete="cc-number"]` | DOM | Definite |
| Page has `<form>` with `input[autocomplete="tel"]` AND `input[autocomplete="email"]` AND a submit button containing "pay", "checkout", "purchase", "complete order" | DOM + text | High |
| `window.Shopify?.Checkout` exists | Global | Definite (Shopify) |
| `window.WooCommerce` exists and current page in cart flow | Global | Medium (WooCommerce) |
| Meta tag `<meta name="checkout-step" ...>` | DOM | Site-specific |

If no signal trips, snippet does nothing. No banner, no listeners.

### Form watcher

Listens on `input` events (debounced 250ms) and `change` events on:
- `input[type="tel"]`, `input[autocomplete="tel"]`, `input[autocomplete="tel-national"]`
- `input[type="email"]`, `input[autocomplete="email"]`
- `input[autocomplete="name"]`, `input[autocomplete="given-name"]`, `input[autocomplete="family-name"]`

Cart contents — best-effort, per detected platform:
- Shopify: `window.Shopify.Checkout?.lineItems` or scrape `.product-table-row`
- WooCommerce: scrape `.woocommerce-checkout-review-order-table`
- Stripe Checkout: read `[data-testid="product-summary"]` if visible
- Generic: scrape any element matching `[class*="cart"][class*="item"]`, `[class*="line-item"]`

Each detected field updates an in-memory `CheckoutSnapshot`:
```ts
type CheckoutSnapshot = {
  phone?: string;
  email?: string;
  name?: string;
  cart_lines: Array<{ title?: string; qty?: number; price_cents?: number }>;
  cart_total_cents?: number;
  store_url: string;
  store_name?: string;     // from <title> or og:site_name
  detected_platform: "shopify" | "woocommerce" | "stripe_checkout" | "generic";
  consent_given: boolean;
  page_entered_at: number;
};
```

### Abandonment triggers

| Trigger | Implementation | Notes |
|---|---|---|
| **Exit-intent** | `mouseleave` on `<html>` where `clientY <= 0` AND velocity upward | Desktop only |
| **Idle** | No `input`/`mousemove`/`scroll` for 60s after first phone input | Both |
| **Tab hidden** | `visibilitychange` → hidden, then no return within 30s | Both |
| **Manual fallback** | Snippet exposes `window.Lasso.fire('abandon_manual')` | For demo backup |

Fire the event when ALL of:
- `consent_given === true`
- `phone` is present and validates (E.164)
- An abandonment trigger fires
- Cart total ≥ configurable threshold (default $10, override per-merchant)

Debounce: only one event per page-load.

### Consent banner

Slides down from the top when checkout is detected, after a 2s delay (let the page settle).

```
┌──────────────────────────────────────────────────────────┐
│  💬 If you have questions, Lasso can call to help.       │
│     ☐ Yes, you can call me at the number above           │
│     [ no thanks, hide ]                                  │
└──────────────────────────────────────────────────────────┘
```

Style: shadow DOM, fixed top, slides in via translateY, dismisses to `localStorage` for 7 days.

### Event payload (snippet → server)

```ts
POST /checkout-event
{
  merchant_id: "acme",       // from script data-merchant attr
  trigger: "exit_intent" | "idle" | "tab_hidden" | "manual",
  snapshot: CheckoutSnapshot,
  page_url: string,
  user_agent: string,
  page_entered_at: number,   // ms timestamp
  fired_at: number
}
```

Use `navigator.sendBeacon()` so the event survives tab close. Fallback to `fetch({keepalive: true})`.

---

## 3. Server — call orchestration

### Stack

- Node 20+, Fastify (faster than Express, lighter than Hono+adapters for this)
- TypeScript, ESM
- Supabase JS client for DB
- All sponsor clients in `src/clients/`
- Zod for request validation
- pino for structured logging

### Routes

```
POST /checkout-event           ← snippet posts here
POST /webhooks/stripe          ← stripe webhook for attribution
POST /webhooks/agentphone      ← agentphone call-ended webhook
GET  /api/calls                ← dashboard list
GET  /api/calls/:id            ← dashboard detail
GET  /api/stats                ← recovered $$ counter
GET  /health                   ← health check
```

### Call pipeline (the heart)

`src/agents/orchestrator.ts`:

```ts
async function triggerCall(event: CheckoutEvent): Promise<void> {
  // 1. Persist event
  const callRow = await db.calls.insert({ status: "preparing", ...event });

  // 2. Fetch caller history (Supermemory)
  const history = await supermemory.get(`${event.merchant_id}:${event.phone}`);

  // 3. Make sure we have a Moss index for this merchant
  const indexName = `merchant_${event.merchant_id}`;
  if (!await moss.indexExists(indexName)) {
    const pages = await firecrawl.crawl(event.store_url, { limit: 20 });
    await moss.createIndex(indexName, pages.map(toMossDoc), { modelId: "moss-minilm" });
  }

  // 4. Build system prompt
  const systemPrompt = buildSystemPrompt({
    storeName: event.store_name,
    cart: event.cart_lines,
    cartTotal: event.cart_total_cents,
    callerHistory: history,
    customerName: event.name,
  });

  // 5. Place call
  const call = await agentphone.calls.create({
    to: event.phone,
    from: process.env.LASSO_PHONE_NUMBER,
    prompt: systemPrompt,
    voice: "rachel",  // or whatever AgentPhone exposes
    tools: [
      sendCheckoutLinkTool(event.merchant_id, event.email),
      lookupStoreTool(indexName),   // queries Moss
      offerDiscountTool(event.merchant_id),
    ],
    webhook_url: `${process.env.PUBLIC_URL}/webhooks/agentphone`,
    metadata: { call_row_id: callRow.id },
  });

  await db.calls.update(callRow.id, { agentphone_call_id: call.id, status: "ringing" });
}
```

### System prompt structure

```
You are calling on behalf of {storeName}.

Context:
- Customer name: {name or "the customer"}
- Cart at time of abandonment: {cart formatted}
- Total: ${cartTotal/100}
- Time since they left: {seconds}

What we know about this customer from prior contact:
{Supermemory facts, or "this is their first call"}

Your job:
1. Open warmly. Reference the specific item in their cart.
2. Ask one open question: "I noticed you were about to check out — was there something I could help with?"
3. Listen. If they raise an objection (price, shipping, sizing, trust), use lookup_store to answer.
4. Offer ONE remedy if appropriate: a discount, free shipping, or just the checkout link by SMS.
5. If they say yes, use send_checkout_link.
6. End the call within 90 seconds unless they're actively engaged.

Constraints:
- Never claim a discount without using offer_discount tool.
- If they ask "how did you get my number," answer honestly: they entered it on the checkout page and opted in for callbacks.
- If they say "remove me" or "stop calling," respond yes and end the call. Never call back.
```

### In-call tools

- `lookup_store(query)` → calls `moss.query(indexName, query, { topK: 3 })` → returns chunks
- `send_checkout_link(via)` → SMS via AgentPhone messaging, or email via AgentMail
- `offer_discount(percent)` → for the demo, just logs and returns "discount code: LASSO10"; in real product would hit merchant API

### Post-call write to Supermemory

```ts
async function persistCallFacts(call: Call, transcript: string) {
  const facts = await extractFacts(transcript);  // small Claude/Gemini call
  await supermemory.store(`${call.merchant_id}:${call.phone}`, {
    facts,
    raw_text: transcript,
    metadata: {
      source: "lasso_call",
      call_id: call.id,
      cart_total_cents: call.cart_total_cents,
      outcome: call.outcome,
      timestamp: new Date().toISOString(),
    },
  });
}
```

Facts to extract: their concern (price, shipping, sizing, trust, comparison-shopping), whether they're a repeat customer, any preferences mentioned, any product they were comparing to.

---

## 4. Storage — Supabase schema

Single source of truth. Realtime feeds the dashboard.

```sql
-- merchants: who's using Lasso
CREATE TABLE merchants (
  id TEXT PRIMARY KEY,             -- "acme", from snippet data-merchant
  name TEXT,
  primary_domain TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- calls: every outbound attempt
CREATE TABLE calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  phone TEXT NOT NULL,
  email TEXT,
  customer_name TEXT,
  page_url TEXT,
  cart_lines JSONB,
  cart_total_cents INTEGER,
  trigger TEXT,                    -- exit_intent | idle | tab_hidden | manual
  status TEXT,                     -- preparing | ringing | connected | completed | failed | no_answer
  outcome TEXT,                    -- recovered | declined | unreachable | error
  agentphone_call_id TEXT,
  transcript TEXT,
  duration_secs INTEGER,
  recovered_cents INTEGER,         -- set by stripe webhook
  created_at TIMESTAMPTZ DEFAULT now(),
  ended_at TIMESTAMPTZ
);

CREATE INDEX calls_merchant_status_idx ON calls(merchant_id, status, created_at DESC);
CREATE INDEX calls_phone_merchant_idx ON calls(merchant_id, phone);

-- stripe_attributions: link Stripe charges back to calls
CREATE TABLE stripe_attributions (
  payment_intent_id TEXT PRIMARY KEY,
  call_id UUID REFERENCES calls(id),
  amount_cents INTEGER NOT NULL,
  matched_via TEXT,                -- email | phone | metadata
  created_at TIMESTAMPTZ DEFAULT now()
);
```

Dashboard subscribes to `calls` realtime channel; counters recompute on insert/update.

---

## 5. Identity & memory tagging (Supermemory)

Single rule: **every Supermemory write tags with `{merchant_id}:{phone}`.** Never just `{phone}`. Never just `{email}`. The merchant prefix is the tenant boundary — if we forget it, customer A's facts leak to merchant B.

```ts
function memoryTag(merchantId: string, phone: string): string {
  // E.164 normalize phone first
  return `${merchantId}:${normalizePhone(phone)}`;
}
```

Wrap this in a single helper, use it everywhere. Treat it as a security boundary.

Cross-channel stitching post-hackathon: when email is also known, write a backref record so a future SMS or email touchpoint finds the same memory. Out of scope for this weekend.

---

## 6. Demo store

`demo-store/` is a static HTML page we serve via `npx serve demo-store -p 5500`.

- One product (the iconic hackathon prop — a coffee mug, a hoodie, whatever)
- Add-to-cart button
- Checkout form with name/email/phone/address fields
- "Complete purchase" submit (does nothing, intentionally — we abandon)
- Has `<script src="http://localhost:1234/snippet.js" data-merchant="demo">` at bottom of `<body>`

Purpose: known-good environment for stage. Real stores are the headline; this is the safety net.

---

## 7. Open decisions (parking lot)

- **Phone provisioning** — one AgentPhone number for the demo, hard-coded? Or per-merchant? Demo: one number is fine.
- **Voice selection** — which voice on AgentPhone? Tune for warmth, not corporate. Pick one before stage day.
- **LLM choice** — Gemini Flash Lite (~540ms TTFT, fits voice budget) vs. Haiku 4.5 (~740ms). Default Flash Lite, fall back to Haiku if Flash quality is bad.
- **Site scrape caching** — first call to a merchant triggers a 20-page Firecrawl. Cache for 24h? Forever until invalidated? Demo: cache forever in-memory.
- **Error states on stage** — what if AgentPhone is down? What if Firecrawl is slow? Need a fake-mode flag that skips real calls and just shows the UI.

These get answered as we hit them. None block scaffolding.
