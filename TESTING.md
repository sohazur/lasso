# Testing Lasso on a real site

This is the field guide for getting Lasso to fire a real call when an actual customer abandons a real checkout. Use it the first time you try a non-demo site.

## Prereqs (verify before you start)

```bash
# Production server is alive:
curl https://lassoserver-production.up.railway.app/health
# → {"ok":true,"service":"lasso-server"}

# AgentPhone API is back up (was down earlier):
KEY=$(grep '^AGENTPHONE_API_KEY=' .env | cut -d= -f2)
curl -s -m 5 -w "\nHTTP %{http_code}\n" -H "Authorization: Bearer $KEY" https://api.agentphone.ai/v1/agents | tail -1
# → HTTP 200

# Railway has PUBLIC_URL set to the production URL (check Railway → Variables)
# Without this, the webhook won't be registered with AgentPhone and our
# voice turns won't reach our LLM — calls will use AgentPhone's hosted fallback.
```

## Step 1: Pick a site

The best first try is a site you fully control with a custom-built checkout.

**Good first targets:**
- A custom Next.js/React e-commerce site you've built
- A WooCommerce shop you administer
- A Wix/Squarespace/Webflow checkout where you can paste custom HTML
- A staging environment for a real store

**Bad first targets (defer these):**
- **Shopify default checkout** — locked-down domain, can't inject scripts unless you have Shopify Plus
- **Stripe-hosted checkout (`checkout.stripe.com`)** — Stripe controls that domain, can't inject
- **PayPal-hosted flow** — same problem
- **Any site you don't have edit access to**

## Step 2: Onboard the merchant

Run the dashboard locally and point it at production:

```bash
cd /Users/sohazur/Desktop/ReachLLM/lasso/dashboard
NEXT_PUBLIC_LASSO_SERVER=https://lassoserver-production.up.railway.app npm run dev
```

Open `http://localhost:3000/onboarding`. Enter:
- **URL**: the merchant's homepage (e.g., `https://acmecoffee.com`)
- Optional: discount code, tone, notes

Click "Start onboarding". You'll see it walk through scraping → indexing → ready (~30-90 seconds).

**If onboarding fails**, the most common reasons:
- **Firecrawl can't crawl** — the site blocks bots or returns 403. Check the Railway logs.
- **Moss quota exhausted** — `/api/admin/moss/indexes` will tell you. Delete one with `DELETE /api/admin/moss/indexes/{name}`.

## Step 3: Paste the snippet onto the checkout page

The onboarding flow gives you the exact `<script>` tag. It looks like:

```html
<script
  src="https://lassoserver-production.up.railway.app/snippet.js"
  data-merchant="your-merchant-id"
  data-server="https://lassoserver-production.up.railway.app"
  async
></script>
```

Put it near the bottom of `<body>` on the **checkout page only**, or on every page if it's a SPA. If your site has a Content-Security-Policy, you may need to add `lassoserver-production.up.railway.app` to `script-src`.

## Step 4: Verify the snippet booted

Open the merchant site's checkout in your browser, then open DevTools console. Within a couple of seconds you should see:

```
[lasso] checkout detected (generic, high): form has tel + email + pay-like submit
[lasso] snapshot: {phone: undefined, email: undefined, ...}
```

**If you don't see this, in priority order:**

1. **Look in the Network tab** for `snippet.js`. Status should be `200`. If `404` → wrong URL. If `CORS error` → server CORS misconfigured (shouldn't happen, we're wide-open).
2. **No `[lasso]` log at all** → script tag missing `data-merchant`, or content-security-policy blocked the script. Check the console for CSP violations.
3. **`[lasso] not a checkout page, standing down`** → detection didn't match. Run `window.Lasso?.fire('manual')` as a last resort to bypass detection.

## Step 5: Fill the form + abandon

Type into the checkout form. **Phone number must be in E.164 format with `+`** (e.g., `+14155551234`). The snapshot log in the console will update as you type.

Then **close the tab**. Or alternatively, in the console:

```js
window.Lasso.fire()
```

Your phone should ring within 5-10 seconds from `+18154964627` (or whatever AgentPhone number you have attached to the shared agent).

## What success looks like

In Railway logs (you can stream them from the Railway dashboard → Deployments → View logs):

```
[lasso] /checkout-event: call placed (call_id=abc-123)
[lasso] webhook-turn: event=agent.message channel=voice direction=inbound from=+14155551234 msg="hello?"
[lasso] webhook-turn: LLM raw="{\"text\":\"Hey Sohazur, quick call about your checkout — got a sec?\"}"
[lasso] webhook-turn: → {"text":"Hey Sohazur, quick call about your checkout — got a sec?"}
```

If you see all four lines for each turn, **the full webhook-mode pipeline is working end-to-end.**

## Common failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| `/checkout-event` returns 202 but no call rings | AgentPhone API down or rate-limited | Check `https://api.agentphone.ai/v1/agents` returns 200 |
| Phone rings but agent says hosted-mode generic things | Webhook URL not registered, signature verification rejected request | Confirm `PUBLIC_URL` is set on Railway; check `[lasso] webhook-turn:` lines in logs |
| Phone rings but agent doesn't know cart contents | Call not found in DB by phone, or merchant not onboarded | Check `/api/calls` returns this call; confirm merchant status=ready |
| Agent says "sending the link" but no SMS arrives | `POST /v1/messages` failed | Check Railway logs for `[lasso] sendCheckoutSms: sendMessage threw` |
| Snippet boots but doesn't fire on tab close | `sendBeacon` blocked, or phone digits < 7 | Check console for `[lasso] sendCheckoutEvent → sendBeacon ok=` |
| Onboard form-fill works but no call after close | `cart_total_cents` < $10 threshold | Set a cart total ≥ $10, or fire manually via `window.Lasso.fire()` |

## Test scripts as fallback

If the browser flow doesn't work, you can still test the server side directly:

```bash
# Fire an event as if a real checkout was abandoned
PHONE="+14155551234" cd /Users/sohazur/Desktop/ReachLLM/lasso && \
  SERVER_URL=https://lassoserver-production.up.railway.app ./scripts/fire-abandonment.sh
```

This tells you whether the *server* path works, isolating snippet issues.
