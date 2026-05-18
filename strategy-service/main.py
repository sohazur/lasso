"""FastAPI app: receive abandoned-checkout events, place recovery calls, follow up via SMS."""
import json
import logging
import os
import re
from pathlib import Path
from typing import Any

from anthropic import AsyncAnthropic
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("recovery")

from strategy import get_concern_playbook
from prompt_builder import build_call_prompt
from voice_agent import run_claude_with_tools
import agentphone_client
import stripe_client

app = FastAPI(title="YC Hackathon — Cart Recovery Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$|^https?://([a-z0-9-]+\.)*ngrok(-free)?\.(io|app|dev)$|^https?://([a-z0-9-]+\.)*netlify\.app$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory store keyed by call_id. Survives across requests but not restarts.
# Hackathon scope — swap for Redis/DB for production.
call_contexts: dict[str, dict[str, Any]] = {}

_anthropic = AsyncAnthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))
_JSON_FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$", re.MULTILINE)


@app.get("/api/health")
async def health():
    return {"status": "ok"}


@app.post("/api/abandon")
async def abandon(request: Request):
    session = await request.json()
    customer = session.get("customer", {})
    cart = session.get("cart", {})

    log.info(
        "abandoned checkout: %s — cart total $%.2f",
        customer.get("name", "unknown"),
        cart.get("total", 0),
    )

    # Deterministic playbook + per-call system prompt. No LLM call here.
    playbook = get_concern_playbook(session)
    system_prompt, opening, context_block = build_call_prompt(session)
    log.info("playbook concern: %s", playbook["concern"])

    to_number = customer.get("phone")
    if not to_number:
        return {"status": "error", "error": "customer.phone missing"}

    # Webhook mode: do NOT pass system_prompt to AgentPhone. The agent calls
    # /api/voice on every turn and Claude drives the conversation. We still
    # store system_prompt locally so the voice webhook can read it.
    call_id = agentphone_client.place_call(
        to_number=to_number,
        opening_greeting=opening,
    )
    log.info("call placed: %s → %s", call_id, to_number)

    # Dashboard reads `briefing` — keep the field name, populate from the
    # deterministic context_block so the dashboard still works.
    call_contexts[call_id] = {
        "session": session,
        "playbook": playbook,
        "briefing": context_block,
        "system_prompt": system_prompt,
        "opening": opening,
    }

    return {
        "status": "calling",
        "call_id": call_id,
        "playbook": playbook,
        "briefing": context_block,
    }


@app.post("/api/voice")
async def voice_webhook(request: Request):
    """Per-turn voice webhook — Claude drives the conversation loop.

    AgentPhone POSTs here on every agent turn in webhook mode. We respond with
    NDJSON streaming: an interim chunk first (so the caller hears something
    quickly), then the final Claude-generated text. If Claude calls the
    transfer_to_founder tool, the final chunk also carries action: "transfer".
    """
    payload = await request.json()

    if payload.get("channel") and payload.get("channel") != "voice":
        return {"ok": True}

    # Defensive call_id extraction across plausible payload shapes.
    call_id = (
        payload.get("callId")
        or payload.get("call_id")
        or (payload.get("data") or {}).get("callId")
        or (payload.get("data") or {}).get("call_id")
    )
    if not call_id:
        log.warning("voice webhook: no call_id in payload: %s", list(payload.keys()))
        return {"text": "Sorry, give me one moment."}

    ctx = call_contexts.get(call_id)
    if not ctx:
        log.warning("voice webhook: no context for call_id=%s — falling back", call_id)
        # Don't break the call — provide a sane generic response.
        return {"text": "Hi, this is Sarah from Saaya. How can I help?"}

    # Build message history from AgentPhone's payload.
    recent = payload.get("recentHistory") or payload.get("recent_history") or []
    messages: list[dict] = []
    for turn in recent:
        if not isinstance(turn, dict):
            continue
        direction = turn.get("direction") or turn.get("role") or "inbound"
        content = turn.get("content") or turn.get("text") or ""
        if not content:
            continue
        role = "assistant" if direction in ("outbound", "agent", "assistant") else "user"
        messages.append({"role": role, "content": content})

    # Claude requires first message to be user. If the call just connected
    # and the agent's initial_greeting is the only thing so far, the history
    # starts with the agent. Prepend a placeholder user turn.
    if not messages or messages[0]["role"] != "user":
        messages.insert(0, {"role": "user", "content": "(call just connected)"})

    system_prompt = ctx.get("system_prompt") or build_call_prompt(ctx["session"])[0]

    async def generate():
        # 1) Interim chunk — buys time while Claude thinks.
        yield json.dumps({"text": "...", "interim": True}) + "\n"

        # 2) Run Claude (with tool-use loop). Returns {"text", "action"}.
        result = await run_claude_with_tools(
            system_prompt=system_prompt,
            messages=messages,
            call_id=call_id,
            session=ctx["session"],
            call_contexts=call_contexts,
        )

        final = {"text": result.get("text") or "Okay."}
        if result.get("action") == "transfer":
            final["action"] = "transfer"
        yield json.dumps(final) + "\n"

    return StreamingResponse(generate(), media_type="application/x-ndjson")


@app.post("/api/agentphone-webhook")
async def agentphone_webhook(request: Request):
    event = await request.json()
    event_type = event.get("type") or event.get("event") or event.get("event_type")
    log.info("webhook event: %s", event_type)

    if event_type != "agent.call_ended":
        return {"status": "ignored", "event": event_type}

    data = event.get("data") or event
    call_id = data.get("call_id") or data.get("id") or data.get("callId") or event.get("call_id")

    ctx = call_contexts.get(call_id)
    if not ctx:
        log.warning("no context for call_id=%s — ignoring", call_id)
        return {"status": "no_context", "call_id": call_id}

    # PATH A (webhook mode): Claude already authorized a payment link
    # mid-call via the send_payment_link tool. The Stripe link is already
    # generated and queued.
    pending = ctx.get("pending_sms")
    if pending:
        return await _send_payment_sms(call_id, ctx, pending)

    # PATH B (fallback): legacy hosted-mode flow — re-analyze the transcript
    # with Claude to decide post-hoc. Useful while migrating between modes.
    transcript = data.get("transcript") or data.get("transcripts") or []
    decision = await _evaluate_transcript(transcript, ctx)
    log.info("transcript decision: %s", decision)

    if not decision.get("agreed_to_pay"):
        return {"status": "no_payment", "call_id": call_id, "decision": decision}

    cart_total = ctx["session"].get("cart", {}).get("total", 0)
    final_dollars = (decision.get("final_total_cents") / 100) if decision.get("final_total_cents") else float(cart_total)
    fallback_pending = {
        "url": None,  # generate fresh below
        "total": final_dollars,
        "discount": decision.get("reason", "no discount"),
    }
    return await _send_payment_sms(call_id, ctx, fallback_pending)


async def _send_payment_sms(call_id: str, ctx: dict, pending: dict) -> dict:
    """Generate the Stripe link (if not already) and SMS it to the customer."""
    customer = ctx["session"].get("customer", {}) or {}
    cart = ctx["session"].get("cart", {}) or {}

    payment_url = pending.get("url")
    if not payment_url:
        items = cart.get("items", []) or []
        product_name = f"Saaya order — {len(items)} item{'s' if len(items) != 1 else ''}"
        try:
            payment_url = stripe_client.create_payment_link(
                amount_cents=int(round(float(pending["total"]) * 100)),
                product_name=product_name,
                customer_email=customer.get("email"),
            )
        except Exception as e:
            log.error("stripe link generation failed: %s", e)
            return {"status": "stripe_failed", "call_id": call_id, "error": str(e)}

    log.info("payment link for call %s: %s", call_id, payment_url)

    first_name = (customer.get("name") or "there").split()[0]
    body = (
        f"Hi {first_name}! Here's your checkout link from Saaya 🌸\n"
        f"{payment_url}\n\n"
        f"Let me know if you need anything else — I'm here. — Sarah"
    )

    try:
        sms_id = agentphone_client.send_sms(to_number=customer["phone"], message=body)
        log.info("sms sent: %s", sms_id)
        return {
            "status": "payment_sent",
            "call_id": call_id,
            "payment_url": payment_url,
            "sms_id": sms_id,
        }
    except Exception as e:
        log.error("sms send failed (likely 10DLC block): %s", e)
        # Capture the intended SMS so the dashboard can surface it.
        ctx["sms_would_have_been"] = body
        ctx["sms_error"] = str(e)
        return {
            "status": "sms_blocked",
            "call_id": call_id,
            "payment_url": payment_url,
            "would_have_sent": body,
            "error": str(e),
        }


@app.get("/api/calls/{call_id}")
async def get_call(call_id: str):
    ctx = call_contexts.get(call_id)
    if not ctx:
        return {"status": "not_found", "call_id": call_id}
    return {"status": "ok", "call_id": call_id, **ctx}


# ───────────────────────────── DASHBOARD APIS ─────────────────────────────

_PROMPTS_DIR = Path(__file__).parent / "prompts"
_ALLOWED_PROMPTS = {"behavior", "brand_brief"}


@app.get("/api/prompts/{name}")
async def get_prompt(name: str):
    if name not in _ALLOWED_PROMPTS:
        raise HTTPException(404, f"unknown prompt: {name}")
    path = _PROMPTS_DIR / f"{name}.md"
    return {"name": name, "content": path.read_text()}


@app.post("/api/prompts/{name}")
async def save_prompt(name: str, request: Request):
    if name not in _ALLOWED_PROMPTS:
        raise HTTPException(404, f"unknown prompt: {name}")
    body = await request.json()
    content = body.get("content", "")
    path = _PROMPTS_DIR / f"{name}.md"
    path.write_text(content)
    log.info("prompt updated: %s (%d chars)", name, len(content))
    return {"name": name, "saved": True, "bytes": len(content)}


@app.get("/api/playbooks")
async def get_playbooks():
    """Return the current strategy playbooks (data, not prose)."""
    path = _PROMPTS_DIR / "playbooks.json"
    import json as _json
    return _json.loads(path.read_text())


@app.post("/api/playbooks")
async def save_playbooks(request: Request):
    """Overwrite the strategy playbooks. Body must be valid JSON matching the schema."""
    import json as _json
    body = await request.json()
    if not isinstance(body, dict) or "by_exit_point" not in body:
        raise HTTPException(400, "missing required key: by_exit_point")
    path = _PROMPTS_DIR / "playbooks.json"
    path.write_text(_json.dumps(body, indent=2) + "\n")
    log.info("playbooks updated (%d exit points, %d overrides)",
             len(body.get("by_exit_point", {})), len(body.get("overrides", {})))
    return {"saved": True}


@app.get("/api/call-log")
async def call_log(limit: int = 20):
    """Recent calls for this agent (proxied from AgentPhone)."""
    from agentphone import AgentPhone
    client = AgentPhone(api_key=os.getenv("AGENTPHONE_API_KEY"))
    try:
        result = client.calls.list(limit=limit)
    except Exception as e:
        return {"error": str(e), "calls": []}
    calls = result.data if hasattr(result, "data") else result
    out = []
    for c in calls:
        out.append({
            "id": c.id,
            "status": c.status,
            "duration_seconds": c.duration_seconds,
            "to_number": c.to_number,
            "from_number": c.from_number,
            "started_at": c.started_at,
            "ended_at": c.ended_at,
            "agent_name": c.agent_name,
        })
    return {"calls": out}


@app.get("/api/calls/latest")
async def latest_call():
    """Return the most recently-placed call context (briefing + system prompt + opening)."""
    if not call_contexts:
        return {"status": "none"}
    call_id = list(call_contexts.keys())[-1]
    return {"status": "ok", "call_id": call_id, **call_contexts[call_id]}


@app.get("/api/calls/{call_id}/live")
async def call_live(call_id: str):
    """Fetch live status + transcript from AgentPhone (proxied)."""
    from agentphone import AgentPhone
    client = AgentPhone(api_key=os.getenv("AGENTPHONE_API_KEY"))
    try:
        call = client.calls.get(call_id)
    except Exception as e:
        return {"error": str(e), "call_id": call_id}

    turns = []
    for t in (call.transcripts or []):
        turns.append({
            "user": (t.transcript or "").strip(),
            "agent": (t.response or "").strip(),
            "created_at": t.created_at,
        })
    return {
        "call_id": call.id,
        "status": call.status,
        "duration_seconds": call.duration_seconds,
        "from_number": call.from_number,
        "to_number": call.to_number,
        "started_at": call.started_at,
        "ended_at": call.ended_at,
        "turns": turns,
    }


@app.post("/api/test-call")
async def test_call(request: Request):
    """Dashboard convenience — trigger an abandonment with a sample payload (or one provided)."""
    body = await request.json() if request.headers.get("content-length", "0") != "0" else {}
    payload = body or {
        "customer": {"name": "Shanzila Ahmed", "phone": "+16502487860", "email": "sohazur@reachllm.com"},
        "cart": {
            "items": [
                {"id": "walima-002", "name": "Pastel Mint Walima Lehenga", "price": 280000, "qty": 1,
                 "collection": "bridal", "type": "lehenga", "customization": None},
                {"id": "sherwani-003", "name": "Cream Silk Sherwani", "price": 340000, "qty": 1,
                 "collection": "menswear", "type": "sherwani", "customization": None},
            ],
            "subtotal": 620000, "shipping": 9500, "total": 629500,
        },
        "signals": {
            "exitPoint": "payment", "stepNumber": 5, "stepName": "payment",
            "timeInCheckout": 180, "secondsIdle": 0, "totalSessionTime": 720,
            "reason": "tab-hidden", "shippingCostShock": False, "discountCodeFailed": False,
            "trustHesitation": False, "returningVisitor": False,
        },
        "saaya": {"country": "US", "city": "San Francisco", "shippingName": "United States",
                  "shippingDays": "7-12 business days", "paymentMethod": "card"},
        "timestamp": "2026-05-18T01:00:00Z",
    }
    # Re-use the same handler.
    class _R:
        async def json(self): return payload
    return await abandon(_R())


# ───────────────────────────── STATIC DASHBOARD ─────────────────────────────
_STATIC_DIR = Path(__file__).parent / "static"
if _STATIC_DIR.exists():
    app.mount("/dashboard", StaticFiles(directory=str(_STATIC_DIR), html=True), name="dashboard")


async def _evaluate_transcript(transcript: Any, ctx: dict) -> dict:
    """Ask Claude: did the agent agree to send a payment link? At what total?"""
    cart_total = ctx["session"].get("cart", {}).get("total", 0)
    transcript_text = _format_transcript(transcript)

    response = await _anthropic.messages.create(
        model="claude-sonnet-4-5",
        max_tokens=400,
        system=(
            "You analyze a sales call transcript and decide whether the agent "
            "and customer agreed to complete the purchase. Reply with JSON only:\n"
            '{"agreed_to_pay": bool, "final_total_cents": int|null, "reason": str}\n'
            "final_total_cents reflects any discount the agent offered (in cents). "
            "If no discount was offered but they agreed, set it to the original cart total in cents. "
            "If they did not agree, set it to null."
        ),
        messages=[
            {
                "role": "user",
                "content": (
                    f"Original cart total (dollars): {cart_total}\n\n"
                    f"Transcript:\n{transcript_text}\n\n"
                    "Did the agent and customer agree to send a payment link?"
                ),
            }
        ],
    )

    raw = next((b.text for b in response.content if b.type == "text"), "").strip()
    cleaned = _JSON_FENCE_RE.sub("", raw).strip()
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        log.warning("could not parse transcript decision: %r", raw)
        return {"agreed_to_pay": False, "final_total_cents": None, "reason": "parse_error"}


def _format_transcript(transcript: Any) -> str:
    if not transcript:
        return "(empty transcript)"
    if isinstance(transcript, str):
        return transcript
    lines = []
    for turn in transcript:
        if isinstance(turn, dict):
            user = turn.get("transcript") or turn.get("user") or turn.get("content", "")
            agent = turn.get("response") or turn.get("agent") or ""
            role = turn.get("role")
            if role == "user":
                lines.append(f"user: {user or agent}")
            elif role == "agent":
                lines.append(f"agent: {agent or user}")
            else:
                if user:
                    lines.append(f"user: {user}")
                if agent:
                    lines.append(f"agent: {agent}")
        else:
            lines.append(str(turn))
    return "\n".join(lines)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
