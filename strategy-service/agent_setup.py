"""One-time setup: provision the AgentPhone agent + voice number + webhook.

Defaults to **webhook mode** — AgentPhone calls our /api/voice endpoint on
every turn and Claude drives the conversation loop. The agent's baked-in
system_prompt becomes irrelevant in this mode (we provide it per-turn).

Run once after the initial setup, and re-run any time PUBLIC_WEBHOOK_URL
changes:

    python agent_setup.py

Re-running is safe — reuses any agent / number already on the account.

Env vars used:
    AGENTPHONE_API_KEY   (required)
    PUBLIC_WEBHOOK_URL   (recommended — ngrok or Railway URL)
    FOUNDER_PHONE        (recommended — E.164 number for transfer_to_founder)
    AGENT_VOICE_MODE     (optional — defaults to 'webhook'; use 'hosted' for legacy)
    CONFIRM_BUY_NUMBER=1 (only if no number on account and you want to buy one)
"""
import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

AGENT_NAME = "LAM Cart Recovery"
VOICE = "11labs-Lily"
DEFAULT_VOICE_MODE = "webhook"  # was 'hosted' — switched in the webhook-mode branch


def main():
    api_key = os.getenv("AGENTPHONE_API_KEY")
    if not api_key:
        raise SystemExit("AGENTPHONE_API_KEY not set in .env")

    voice_mode = os.getenv("AGENT_VOICE_MODE", DEFAULT_VOICE_MODE)
    if voice_mode not in ("webhook", "hosted"):
        raise SystemExit(f"AGENT_VOICE_MODE must be 'webhook' or 'hosted', got: {voice_mode!r}")

    from agentphone import AgentPhone

    client = AgentPhone(api_key=api_key)

    behavior_prompt = (Path(__file__).parent / "prompts" / "behavior.md").read_text()
    founder_phone = os.getenv("FOUNDER_PHONE", "").strip()

    # 1. Reuse or create the agent.
    agents = client.agents.list().data
    agent = next((a for a in agents if a.name == AGENT_NAME), None)

    common_kwargs = dict(
        voice=VOICE,
        voice_mode=voice_mode,
        max_silence_ms=15000,
        enable_messaging=True,
    )
    # System prompt is still useful as a fallback (for any call that bypasses
    # our /api/voice webhook). In webhook mode, our per-turn handler overrides
    # it anyway.
    common_kwargs["system_prompt"] = behavior_prompt
    if founder_phone:
        common_kwargs["transfer_number"] = founder_phone

    if agent is None:
        print(f"Creating agent '{AGENT_NAME}' (voice_mode={voice_mode})...")
        agent = client.agents.create(name=AGENT_NAME, **common_kwargs)
    else:
        print(f"Reusing agent '{AGENT_NAME}' ({agent.id}) — updating to voice_mode={voice_mode}...")
        client.agents.update(agent.id, **common_kwargs)
    print(f"  agent_id: {agent.id}")
    if founder_phone:
        print(f"  transfer_number: {founder_phone}")
    else:
        print("  ⚠️  FOUNDER_PHONE not set — transfer_to_founder tool will have no destination.")

    # 2. Pick a voice number. Reuse one already attached; otherwise reuse any
    #    voice-capable number on the account; only buy if you explicitly confirm.
    def _voice_capable(n) -> bool:
        return (n.type or "") != "shared-imessage"

    agent = client.agents.get(agent.id)
    voice_attached = [n for n in (agent.numbers or []) if _voice_capable(n)]
    if voice_attached:
        number = voice_attached[0]
        print(f"  number: {number.phone_number} (already attached, type={number.type})")
    else:
        for n in (agent.numbers or []):
            if not _voice_capable(n):
                print(f"  detaching non-voice number {n.phone_number} (type={n.type})")
                client.agents.detach_number(agent_id=agent.id, number_id=n.id)

        all_numbers = client.numbers.list().data
        unattached = [n for n in all_numbers if not n.agent_id and _voice_capable(n)]
        if unattached:
            number = unattached[0]
            print(f"  attaching existing voice number {number.phone_number} (type={number.type})...")
            client.agents.attach_number(agent_id=agent.id, number_id=number.id)
        else:
            confirm = os.getenv("CONFIRM_BUY_NUMBER")
            if confirm != "1":
                raise SystemExit(
                    "No unattached numbers on account. Re-run with "
                    "CONFIRM_BUY_NUMBER=1 to buy a new one."
                )
            print("  buying a new voice number...")
            number = client.numbers.buy(country="US", agent_id=agent.id)
            print(f"  bought {number.phone_number}")

    # 3. Webhooks. In webhook mode there are TWO webhooks we care about:
    #    - /api/voice  → per-turn voice conversation handler
    #    - /api/agentphone-webhook → call_ended events (SMS follow-up)
    #
    # AgentPhone's `set_webhook` registers a single URL on the agent. The
    # underlying platform routes the right events to whatever path you give it.
    # The voice webhook needs to be set on the agent specifically; the
    # call_ended event is sent to the same agent webhook URL too, just with a
    # different event type — see main.py.
    public_url = os.getenv("PUBLIC_WEBHOOK_URL")
    if public_url:
        # Use /api/voice as the agent webhook — it handles both voice turns
        # (channel == "voice") and lifecycle events. main.py also exposes
        # /api/agentphone-webhook which handles call_ended for SMS triggering.
        # The SDK only supports one URL per agent, so we point at the voice
        # one and let main.py route internally based on payload type.
        voice_webhook = public_url.rstrip("/") + "/api/voice"
        lifecycle_webhook = public_url.rstrip("/") + "/api/agentphone-webhook"
        print(f"  registering agent webhook → {voice_webhook}")
        try:
            client.agents.set_webhook(agent_id=agent.id, url=voice_webhook)
        except Exception as e:
            print(f"  ⚠️  webhook registration failed: {e}")
        print(f"  (call_ended events should ALSO be pointed at {lifecycle_webhook}")
        print( "   — configure that separately in the AgentPhone dashboard if SDK doesn't support multi-URL)")
    else:
        print("  PUBLIC_WEBHOOK_URL not set — skip webhook registration "
              "(re-run after starting ngrok and updating .env).")

    print("\nDone. Put these in .env:")
    print(f"  AGENT_ID={agent.id}")
    print(f"  AGENT_PHONE_NUMBER={number.phone_number}")
    print(f"  AGENT_VOICE_MODE={voice_mode}")


if __name__ == "__main__":
    main()
