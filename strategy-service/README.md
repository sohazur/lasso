# strategy-service

Standalone Python FastAPI microservice. Produces the per-call briefing for the recovery agent, places the AgentPhone call, and serves a control-room dashboard for live prompt + strategy editing and call observation.

**This is a snapshot branch.** Force-pushed; reflects current state, not full history.

## Architecture

```
   abandon event ─► /api/abandon
                        │
                        ▼
            get_concern_playbook(session)         ◄── prompts/playbooks.json
                        │                              (deterministic, editable)
                        ▼
            build_call_prompt(session)            ◄── prompts/behavior.md
                        │                              (Sarah's persona + flow)
                        ▼
            agentphone_client.place_call(...)
                        │
                        ▼
                AgentPhone outbound call
                        │
                        ▼
           /api/agentphone-webhook (call_ended)
                        │
                        ▼
   Anthropic analyzes transcript → Stripe link → SMS
                  (SMS gated on AgentPhone 10DLC)
```

**No LLM in the hot path.** Strategy is a JSON lookup. The per-call system prompt is built deterministically from `behavior.md` + the matched playbook. Anthropic is only called post-call to analyze the transcript and decide whether to send the payment link.

## Files

| File / dir | Role |
|---|---|
| `main.py` | FastAPI app — `/api/abandon`, `/api/agentphone-webhook`, `/api/calls/*`, `/api/prompts/*`, `/api/playbooks`, `/api/call-log`, `/api/test-call`, dashboard mount |
| `strategy.py` | Deterministic playbook lookup. Reads `prompts/playbooks.json`. Maps `exitPoint` (cart / address / shipping_review / payment / order_review) → playbook. `discountCodeFailed` override. |
| `prompt_builder.py` | Reads `behavior.md` + invokes `strategy.get_concern_playbook` + assembles per-call system prompt + opening greeting + context block (the latter is also surfaced on the dashboard). |
| `agentphone_client.py` | AgentPhone SDK wrapper — `place_call` (per-call system_prompt override), `send_sms` (gated on 10DLC). |
| `stripe_client.py` | Generates ad-hoc Stripe Payment Links on the fly. |
| `agent_setup.py` | One-time setup — creates the AgentPhone agent + provisions a voice-capable number + (optional) registers webhook. |
| `playground.py` | Local text REPL — chat with Sarah using the actual `behavior.md` + playbook pipeline, no AgentPhone credits burned. |
| `test_call.py` | Hello-world AgentPhone caller (sanity check). |
| `test_sms.py` | Hello-world AgentPhone SMS (sanity check — currently 403's on 10DLC). |
| `prompts/behavior.md` | Sarah's persona, conversation rules, 4-step flow, hard "do not" list. |
| `prompts/playbooks.json` | Strategy data — concern label, probe wording, and approach per exit point + overrides. **Editable from the dashboard.** Includes the 10% → 20% → 50% discount escalation ladder for payment exits. |
| `prompts/brand_brief.md` | Saaya merchant context — industry, country (Pakistan), currency (PKR), category price norms, what can flex on. **Editable from the dashboard.** |
| `static/index.html` | Control-room dashboard — Website / Brand brief / Strategy / Behavior / Call log sections, all editable, with live call observation. |

## Dashboard

The dashboard at `/dashboard/` provides:

- **Website** — site URL config + (stub) crawl-and-auto-brief for the future KB feature.
- **Brand brief** — full markdown editor for `brand_brief.md`. Save → applies on next call instantly.
- **Strategy** — visual editor for every entry in `playbooks.json` (5 exit points + overrides). Each playbook is a card with concern / probe / approach fields. Save → applies on next call instantly.
- **Behavior** — full markdown editor for `behavior.md`. Save → applies on next call instantly.
- **Call log** — paginated list of every call, auto-refreshing. Click any row to expand briefing + live transcript. Trigger-test-call button.

## Contract — POST /api/abandon

```json
{
  "customer": { "name": "...", "phone": "+1...", "email": "..." },
  "cart": {
    "items": [{ "id": "...", "name": "...", "price": 280000, "qty": 1 }],
    "subtotal": 620000, "shipping": 9500, "total": 629500
  },
  "signals": {
    "exitPoint": "cart" | "address" | "shipping_review" | "payment" | "order_review",
    "stepNumber": 5, "stepName": "...",
    "timeInCheckout": 180, "secondsIdle": 0, "totalSessionTime": 720,
    "reason": "...",
    "shippingCostShock": false, "discountCodeFailed": false,
    "trustHesitation": false, "returningVisitor": false
  },
  "saaya": { "country": "US", "city": "...", "shippingName": "...", "shippingDays": "...", "paymentMethod": "..." },
  "timestamp": "2026-05-18T01:00:00Z"
}
```

## Run

```bash
cd strategy-service
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env  # fill: AGENTPHONE_API_KEY, ANTHROPIC_API_KEY, STRIPE_SECRET_KEY
python agent_setup.py     # one-time, prints AGENT_ID + AGENT_PHONE_NUMBER → paste into .env
uvicorn main:app --reload # http://localhost:8000
```

Dashboard: **http://localhost:8000/dashboard/**

## Integration with the team's TS server

This service is standalone. The team's `server/` (TS Fastify) does its own AgentPhone wiring. To merge:

- The TS orchestrator can `fetch('http://localhost:8000/api/abandon', ...)` to delegate the whole call placement.
- Or expose a `/api/strategy` variant that returns the prompt without placing the call, so the TS server keeps AgentPhone control.

For the hackathon demo, this runs alongside the TS server as a research/iteration tool with its own dashboard.

## Known limitation

Outbound SMS via AgentPhone returns 403 until 10DLC registration is complete. The webhook handler is wired up to call Anthropic → Stripe → SMS, but the SMS step will fail until the AgentPhone account has the outbound-SMS flag enabled. Either work with the AgentPhone team to flip the flag for the hackathon, or stub the SMS step and log to the dashboard.
