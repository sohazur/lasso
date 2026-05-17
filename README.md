# Lasso

**The one-line script that calls back your abandoned checkouts. Works on any site.**

Built for the Call My Agent Hackathon at Y Combinator — May 17, 2026.

---

## What it does

A merchant drops one `<script>` tag onto their checkout page. Lasso:

1. Watches the checkout flow — captures the customer's phone and cart in real time.
2. Detects abandonment — exit-intent, idle, tab-hidden — before the customer is fully gone.
3. **Calls them back within 60 seconds** with a voice agent that knows their cart, knows the store, and asks why they almost left.
4. Logs every call, transcript, and recovered sale in a dashboard.

No app store, no Shopify install, no SDK to wire up. One script tag.

```html
<script src="https://lasso.example/snippet.js" data-merchant="acme"></script>
```

## The demo flow (75 seconds)

1. Open a checkout page (real store + our own fake store as backup).
2. Fill name, phone, email. Don't submit. Move toward closing the tab.
3. **A phone on stage rings within 10 seconds.**
4. Voice agent: *"Hey, I noticed you were checking out on Acme — anything I can help with about the [actual cart item]?"*
5. Customer raises an objection. Agent answers from the live-scraped store knowledge.
6. Customer says yes → agent texts the checkout link → Stripe charge appears on the dashboard.
7. Switch to the dashboard tab: new entry, transcript, recovered revenue counter ticks up.

Close line: *"This is one script tag. Any site can use it tomorrow."*

## Sponsor map

| Sponsor | Role in Lasso | Why it's the right choice |
|---|---|---|
| **AgentPhone (P26)** | Outbound voice call to the customer | The whole demo hinges on this — the phone literally rings on stage |
| **Supermemory** | Cross-call memory: same caller returns → agent remembers | "Same shopper came back, agent picked up where the call left off" |
| **Moss** | Real-time store KB lookups during the call | Agent answers store-specific questions without 800ms RAG lag |
| **Stripe (S09)** | Attribution: track recovered checkouts back to calls | "Recovered $X this hour" — live counter on the dashboard |
| **AgentMail (S25)** | Fallback channel if the call isn't answered | Email follow-up with checkout link + context |
| **Browser Use (W25)** | On-demand site scrape to seed store knowledge at call-time | Agent works on any site without prior onboarding |
| **Sponge (W26)** | (Stretch) Financial rails for merchant payouts / fees | Tracks per-call cost vs. recovered revenue |
| **Google DeepMind** | Gemini Flash Lite as the voice agent brain (~540ms TTFT) | Latency-optimal for voice; uses sponsor model |

## Day-by-day milestones

### Day 1 — Capture + trigger (must-ship)
- [ ] Snippet: checkout detector (Shopify, Stripe Checkout, WooCommerce, generic `<form>` heuristics)
- [ ] Snippet: form watcher (phone, email, cart, store URL)
- [ ] Snippet: exit-intent + idle + tab-visibility triggers
- [ ] Snippet: consent banner UI (opt-in checkbox)
- [ ] Server: `POST /checkout-event` route — receives snippet events, persists to Supabase
- [ ] Server: AgentPhone client — places outbound call with dynamic system prompt
- [ ] Demo store: minimal HTML/CSS checkout page we control (fallback for stage)

### Day 2 — Make the call brilliant (the magic)
- [ ] Server: Firecrawl client — on-demand store scrape at call-trigger time
- [ ] Server: Moss client — index scraped store KB, query during call
- [ ] Server: Supermemory client — write caller facts after each call, read on repeat callers
- [ ] Server: Agent system-prompt builder (cart + store KB + caller history → prompt)
- [ ] Server: In-call tools — "send checkout link via SMS", "issue discount code"
- [ ] Stripe webhook: track completed checkouts → tag as recovered if call preceded them

### Day 2 — Dashboard + polish
- [ ] Dashboard: call log table (timestamp, store, customer, outcome, transcript link)
- [ ] Dashboard: "Recovered today" live counter
- [ ] Dashboard: per-call transcript view with timeline
- [ ] Two pre-tested demo stores
- [ ] AgentMail fallback (if call doesn't connect within 30s)
- [ ] Dry-run the full demo twice end-to-end

## What we're NOT building this weekend

- Multi-merchant signup / billing dashboard (single-merchant demo only)
- Real consent + TCPA flow (we'll show the UX, won't ship to prod)
- Production rate-limiting / abuse prevention
- Merchant onboarding self-service
- Integration with Foyer/talklayer (deferred — separate post-hackathon track)

## Architecture at a glance

```
┌─────────────────────────────┐
│ Merchant's checkout page    │
│   <script src="lasso.js" /> │
└──────────┬──────────────────┘
           │ checkout events
           ▼
┌─────────────────────────────┐      ┌──────────────────┐
│   Lasso server (Fastify)    │─────▶│ Supabase (state) │
└──────┬──────┬───────┬───────┘      └──────────────────┘
       │      │       │
       ▼      ▼       ▼
  AgentPhone  Moss  Supermemory
   (call)    (KB)   (memory)
       │
       ▼
┌─────────────────────────────┐
│ Dashboard (Next.js)         │
│ Live call log + recovered $ │
└─────────────────────────────┘
```

See [SPEC.md](./SPEC.md) for detailed architecture, data flow, and decision rationale.

## Repo layout

```
lasso/
├── snippet/      ← Vanilla TS, the one-line script (~15KB target)
├── server/       ← Fastify backend, sponsor integrations
├── dashboard/    ← Next.js, minimal call log UI
└── demo-store/   ← Fake e-commerce site for stage backup
```

## Getting started

```bash
# Install deps for all workspaces
npm install

# Copy env template and fill in your sponsor API keys
cp .env.example .env

# Run the pieces (in separate terminals)
npm run dev:server     # localhost:3001
npm run dev:dashboard  # localhost:3000
npm run dev:snippet    # watches snippet/src, builds to snippet/dist
```

See `.env.example` for the full sponsor-API checklist.

## Post-hackathon

Lasso is a standalone product for this hackathon. After, it can either:
- Become a Foyer/talklayer feature (the cross-channel proactive recovery layer)
- Stay independent (one-script-tag SaaS for any checkout)
- Pivot into the broader "agent that finishes any conversion" thesis

That decision is for after we win. 🤠
