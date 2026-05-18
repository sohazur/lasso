"""Thin wrapper around the AgentPhone SDK.

The SDK is sync; we call it from async handlers without `asyncio.to_thread`
since hackathon-scale concurrency is fine. If load grows, wrap in `to_thread`.
"""
import os

from agentphone import AgentPhone

_client = AgentPhone(api_key=os.getenv("AGENTPHONE_API_KEY"))
_AGENT_ID = os.getenv("AGENT_ID")


def place_call(
    to_number: str,
    opening_greeting: str | None = None,
    system_prompt: str | None = None,
) -> str:
    """Place an outbound call.

    Mode is decided by whether `system_prompt` is passed:
    - With `system_prompt` → AgentPhone's hosted LLM runs the call (legacy).
    - Without `system_prompt` → webhook mode: AgentPhone calls our /api/voice
      endpoint on every turn. The agent must have `voice_mode='webhook'` and
      a webhook URL configured (see agent_setup.py).

    Returns the AgentPhone call_id.
    """
    if not _AGENT_ID:
        raise RuntimeError("AGENT_ID not set — run agent_setup.py and update .env")

    kwargs: dict = {
        "agent_id": _AGENT_ID,
        "to_number": to_number,
    }
    if opening_greeting:
        kwargs["initial_greeting"] = opening_greeting
    if system_prompt:
        kwargs["system_prompt"] = system_prompt

    call = _client.calls.make(**kwargs)
    return call.id


def send_sms(to_number: str, message: str) -> str:
    """Send an SMS from the agent's number. Returns the AgentPhone message id.

    Raises if the account hasn't completed 10DLC registration (US regulatory
    requirement for A2P SMS). The /api/agentphone-webhook handler catches
    the failure and logs the would-be message for dashboard display.
    """
    if not _AGENT_ID:
        raise RuntimeError("AGENT_ID not set — run agent_setup.py and update .env")

    result = _client.messages.send(
        agent_id=_AGENT_ID,
        to_number=to_number,
        body=message,
    )
    if isinstance(result, dict):
        return result.get("id") or result.get("message_id") or str(result)
    return str(result)
