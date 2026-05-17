# Lasso — Onboarding

How a merchant goes from "I have a website" to "the script tag is live, the KB is indexed, the agent is ready to call" in under 3 minutes.

Companion to `SPEC.md` (which covers the runtime path). This doc covers the *setup* path: dashboard wizard, knowledge base build, memory layout, and the real-time lookup contract during a call.

---

## 1. The merchant's experience

```
Step 1            Step 2                     Step 3
──────            ──────                     ──────
Tell us about     We crawl + index           Drop the script tag
your store        your site                  onto your checkout
   │                 │                          │
   ▼                 ▼                          ▼
URL + name +     Live progress:             <script
private context  scraping → indexing →        src=".../snippet.js"
(coupons, tone)  generating brief →           data-merchant="...">
                 ready                       </script>
```

One screen per step. No login (hackathon scope). The dashboard is the merchant's home; after step 3 it shows the call log.

Inspirations pulled in:
- **Foyer onboarding** (`/Users/sohazur/Desktop/ReachLLM/talklayer/packages/server/src/routes/onboard.ts`): single-URL → full pipeline kickoff, async background work, status polling with friendly error messages per failed step.
- **Supermemory** (https://supermemory.ai/docs/intro): tagged record store, infinite context. We use it for brand briefing + per-caller memory.
- **Moss** (https://docs.moss.dev/docs/start/quickstart): managed vector index, sub-200ms `query`. We use it for the in-call `lookup_store` tool.

---

## 2. The three steps in detail

### Step 1 — "Tell us about your store"

Fields the wizard collects:

| Field | Required | Notes |
|---|---|---|
| `merchant_id` | yes | slug; defaults to slugified name, editable. Used as the `data-merchant` attr and the Supermemory/Moss tenant prefix. |
| `name` | yes | Display name. |
| `url` | yes | The site we crawl. https:// auto-prefixed. |
| `private_context.tone` | no | "warm + concise", "formal", etc. Influences the brand briefing the LLM writes. |
| `private_context.discount_code` | no | If they give us a coupon, the agent can offer it via `offer_discount` tool. |
| `private_context.notes` | no | Free-form ("we ship in 2 days", "don't push the premium plan"). Stored as a `merchant:{id}:private` Supermemory record. |

The wizard `POST`s to `/api/onboard`. Server responds **202** with `{ merchant_id, status: "scraping" }` immediately — the pipeline runs in the background.

### Step 2 — "Building your knowledge base"

The wizard polls `GET /api/onboard/:id/status` every 1.5s. The status enum is the source of truth:

| Status | UI says |
|---|---|
| `scraping` | "Reading your site…" with a Firecrawl-styled spinner |
| `indexing` | "Indexing into Moss + Supermemory…" |
| `ready` | "✅ Knowledge base ready. {N} chunks indexed." → auto-advances to Step 3 |
| `failed` | "Hit a snag at: {failed_step}. [Retry]" — clicking retry re-POSTs `/api/onboard` with the same payload |

Behind the scenes (already implemented in `server/src/agents/onboarding.ts`):

1. Firecrawl crawl, cap 30 pages.
2. Chunk pages (heading-aware, ~500 tokens, sha256-dedup).
3. **Atomic-swap** into Moss: `moss.createIndex("merchant_{id}", chunks)` — replaces any prior index. Moss is the only home for raw chunks.
4. LLM-generate a brand-context briefing from the first ~12 chunks + private context, store under `merchant:{id}:context`.
5. If private context was provided, store a structured version under `merchant:{id}:private`.
6. Provision an AgentPhone agent + number (reuses an existing unattached number if available).
7. Flip status to `ready`.

The wizard never blocks on this — the server returns 202 and the UI shows live progress.

### Step 3 — "Drop this script tag onto your checkout"

```html
<script src="https://lasso.example/snippet.js" data-merchant="{merchant_id}" async></script>
```

Copy-to-clipboard button. Below it: a "Verify install" pulse that hits `POST /checkout-event` with `trigger: "manual"` from a hidden iframe — if we see the event server-side, the wizard marks it verified.

For the demo we also show:
- The AgentPhone number assigned to this merchant (so the demo phone can confirm caller-ID).
- A "Send me a test call" button that fires a synthetic checkout-event with a phone number the user enters.

---

## 3. Memory layout — what lives where

The merchant prefix is a **tenant boundary**. Every write *must* be prefixed by `merchant:{id}`. See `SPEC.md §5` for the rule. The dashboard never writes to memory directly; only the server does, and only via the helpers in `server/src/clients/supermemory.ts`.

### Supermemory tags

| Tag | What it holds | Written by | Read by |
|---|---|---|---|
| `merchant:{id}:context` | Brand briefing (markdown, ~600 tokens). Voice, products, top FAQs, recovery tactics. | onboarding pipeline (step 5) | system-prompt builder at call time |
| `merchant:{id}:private` | Coupon codes, internal notes — never on the public site. | onboarding pipeline (step 6) | system-prompt builder at call time |
| `merchant:{id}:phone:{e164}` | Per-caller memory: extracted facts, raw transcripts. Grows with each call. | post-call `persistCallFacts` | system-prompt builder for repeat callers |

Note: **raw KB chunks live only in Moss**, not Supermemory. The two systems have distinct roles — Moss is the in-call retrieval index; Supermemory holds the LLM-friendly summaries (`context`, `private`) and the cross-call caller memory (`phone:*`). No mirror.

### Moss indexes

One index per merchant: `merchant_{id}` (underscore — Moss naming).

- Built once during onboarding via `createIndex` (atomic replace).
- Queried **only at call time** via the `lookup_store` tool.
- Documents are `{ id, text, metadata: { pageUrl, pageTitle, sectionTitle } }` — same chunks Supermemory has, but Moss owns the embedding + ANN index.

### Supabase (Postgres)

Transactional state only. See `server/src/db/schema.sql`. The dashboard subscribes to `calls` for the realtime log. Onboarding writes/reads the `merchants` row.

---

## 4. Real-time lookup during the call

**Decision: Moss only.** SPEC.md §3 already specified this, and we're sticking with it.

Why not Supermemory for in-call retrieval:
- Supermemory's strength is *contextual memory* across sessions, not sub-200ms vector retrieval.
- Voice latency budget is brutal: TTFT goal ≤ 800ms. A Moss `query` returns in ~150ms; Supermemory retrieval is variable.
- Splitting roles keeps the system legible: **Moss = facts you index once**, **Supermemory = facts you learn over time**.

### The `lookup_store` tool contract

```ts
// Wired in server/src/agents/orchestrator.ts when starting a call
{
  name: "lookup_store",
  description: "Search the merchant's store for facts about products, shipping, returns, sizing, policies. Use when the caller asks a specific question.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Natural-language question." }
    },
    required: ["query"]
  },
  handler: async ({ query }) => {
    const hits = await moss.query(`merchant_${merchantId}`, query, { topK: 3 });
    return hits.map(h => `[${h.metadata.pageTitle}] ${h.text}`).join("\n\n");
  }
}
```

Key constraints:
- `topK = 3` — more than that wastes the agent's token budget and TTS time.
- Format hits with `[Page Title]` prefix so the agent can cite ("on our shipping page…").
- If the call's whole budget is already used (>90s elapsed), the orchestrator can swap in a stub that returns "I don't have that info handy — I'll send a link." — TODO, post-hackathon.

### What about facts learned during *this* call?

Not via Moss. Live-call facts go into a working scratchpad in the agent's context and get persisted to `merchant:{id}:phone:{e164}` via `persistCallFacts` after the call ends. The *next* call to the same phone reads that record back into the system prompt. This is the Supermemory loop and is what the SPEC.md call pipeline describes.

---

## 5. Server contract the dashboard relies on

These already exist; the wizard does not require server changes.

### `POST /api/onboard`

```ts
// body
{
  merchant_id: string,    // [a-z0-9_-]{1,64}
  name: string,
  url: string,            // valid URL
  private_context?: {
    tone?: string,
    discount_code?: string,
    notes?: string,
    [key: string]: unknown
  }
}

// response — 202
{ merchant_id: string, status: "scraping" }

// response — 400
{ error: "invalid_body", issues: ZodIssue[] }
```

### `GET /api/onboard/:id/status`

```ts
// 200
{
  merchant_id: string,
  status: "scraping" | "indexing" | "ready" | "failed",
  failed_step: string | null,   // "scraping" | "indexing" | etc.
  name: string
}

// 404 — unknown merchant
{ error: "not_found" }
```

Polling interval: 1.5s. Stop polling on `ready` or `failed`.

### Out-of-scope endpoints we'd want post-hackathon

- `GET /api/merchants/:id` — full merchant detail (number, agent_id, chunk count) for Step 3's display block. Today the wizard infers what it needs from the status endpoint plus client-side state.
- `POST /api/onboard/:id/verify` — fires a synthetic event so Step 3 can show "✅ Verified".
- `DELETE /api/onboard/:id` — wipe the KB and start over.

---

## 6. Failure modes & retries

| Failure | Where it happens | What the wizard shows | What the user does |
|---|---|---|---|
| URL doesn't resolve | Firecrawl | "We couldn't reach {host}." | Edit URL, retry. |
| Site has zero crawlable pages | onboarding step 2 | "Found 0 pages on {host}. Check robots.txt or try a deeper URL." | Edit URL, retry. |
| Moss `createIndex` 5xx | onboarding step 5 | "Index build hit a snag. Retry?" | Click retry. |
| Supermemory 5xx | onboarding step 5/6 | Same. | Same. |
| LLM call fails (brand context) | onboarding step 6 | **Silent.** Brand context is fail-soft; the agent works without it. | Nothing — proceeds to ready. |
| AgentPhone provisioning fails | onboarding step 7 | **Silent.** Logged; merchant still flips to ready (mock mode if needed). | Nothing for the demo; in production we'd surface this. |

All retries are idempotent: re-POSTing `/api/onboard` with the same `merchant_id` resets to `scraping` and atomic-swaps the new index in.

---

## 7. What we explicitly aren't doing this weekend

- Auth / multi-tenant signup (single-merchant demos only).
- Stripe billing for onboarding.
- A "preview my KB" step (show top chunks before committing). Useful, deferred.
- Cross-channel identity stitching by email — Supermemory tag is phone-only for now.
- Real consent + TCPA flow on the wizard.
- Custom voice picker — one global `LASSO_VOICE_ID` env var for the demo.

---

## 8. File map

| File | Role |
|---|---|
| `server/src/routes/onboard.ts` | HTTP endpoints. **Exists.** |
| `server/src/agents/onboarding.ts` | Pipeline. **Exists.** |
| `server/src/agents/chunker.ts` | Heading-aware chunking. **Exists.** |
| `server/src/clients/{firecrawl,moss,supermemory,agentphone}.ts` | Sponsor wrappers. **Exist, mock-mode capable.** |
| `dashboard/app/onboarding/page.tsx` | The 3-step wizard. **New.** |
| `dashboard/app/lib/api.ts` | Tiny client for `/api/onboard*`. **New.** |
| `dashboard/app/page.tsx` | Home → adds "Onboard a store" CTA. **Edit.** |
