"""Thin wrapper around the AgentPhone SDK.

The SDK is sync; we call it from async handlers without `asyncio.to_thread`
since hackathon-scale concurrency is fine. If load grows, wrap in `to_thread`.
"""
import os

from agentphone import AgentPhone

_client = AgentPhone(api_key=os.getenv("AGENTPHONE_API_KEY"))
_AGENT_ID = os.getenv("AGENT_ID")


def place_call(to_number: str, system_prompt: str, opening_greeting: str) -> str:
    """Place an outbound call with a per-call system prompt + opening line.

    Returns the AgentPhone call_id.
    """
    if not _AGENT_ID:
        raise RuntimeError("AGENT_ID not set — run agent_setup.py and update .env")

    # Drop initial_greeting when empty so the agent waits for the user to
    # say "hello" before speaking (real-human behavior).
    kwargs = {
        "agent_id": _AGENT_ID,
        "to_number": to_number,
        "system_prompt": system_prompt,
    }
    if opening_greeting:
        kwargs["initial_greeting"] = opening_greeting

    call = _client.calls.make(**kwargs)
    return call.id


def send_sms(to_number: str, message: str) -> str:
    """Send an SMS from the agent's number. Returns the AgentPhone message id."""
    if not _AGENT_ID:
        raise RuntimeError("AGENT_ID not set — run agent_setup.py and update .env")

    result = _client.messages.send(
        agent_id=_AGENT_ID,
        to_number=to_number,
        body=message,
    )
    # SDK returns a dict — message id field name may vary; try common ones.
    return result.get("id") or result.get("message_id") or str(result)
