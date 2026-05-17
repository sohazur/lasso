"""One-time setup: create the AgentPhone agent + provision a voice number + register webhook.

Run once:
    python agent_setup.py

Copy AGENT_ID and AGENT_PHONE_NUMBER into backend/.env. Re-running is safe:
the script reuses any agent with the same name (and updates its prompt) and
any voice number already on the account.
"""
import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

AGENT_NAME = "LAM Cart Recovery"
VOICE = "11labs-Lily"


def main():
    api_key = os.getenv("AGENTPHONE_API_KEY")
    if not api_key:
        raise SystemExit("AGENTPHONE_API_KEY not set in .env")

    from agentphone import AgentPhone

    client = AgentPhone(api_key=api_key)

    behavior_prompt = (Path(__file__).parent / "prompts" / "behavior.md").read_text()

    # 1. Reuse or create the agent.
    agents = client.agents.list().data
    agent = next((a for a in agents if a.name == AGENT_NAME), None)

    if agent is None:
        print(f"Creating agent '{AGENT_NAME}'...")
        agent = client.agents.create(
            name=AGENT_NAME,
            voice_mode="hosted",
            voice=VOICE,
            system_prompt=behavior_prompt,
            max_silence_ms=15000,
            enable_messaging=True,
        )
    else:
        print(f"Reusing agent '{AGENT_NAME}' ({agent.id}) — updating prompt + voice...")
        client.agents.update(
            agent.id,
            voice=VOICE,
            system_prompt=behavior_prompt,
            max_silence_ms=15000,
            enable_messaging=True,
        )
    print(f"  agent_id: {agent.id}")

    # 2. Pick a voice number. Reuse one already attached; otherwise reuse any
    #    number on the account and attach it; only buy as a last resort.
    # iMessage-only numbers can't carry voice — exclude them everywhere.
    def _voice_capable(n) -> bool:
        return (n.type or "") != "shared-imessage"

    agent = client.agents.get(agent.id)
    voice_attached = [n for n in (agent.numbers or []) if _voice_capable(n)]
    if voice_attached:
        number = voice_attached[0]
        print(f"  number: {number.phone_number} (already attached, type={number.type})")
    else:
        # Detach any non-voice numbers we may have inherited.
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

    # 3. Configure webhook for call lifecycle events if PUBLIC_WEBHOOK_URL is set.
    public_url = os.getenv("PUBLIC_WEBHOOK_URL")
    if public_url:
        webhook_url = public_url.rstrip("/") + "/api/agentphone-webhook"
        print(f"  registering webhook → {webhook_url}")
        client.agents.set_webhook(agent_id=agent.id, url=webhook_url)
    else:
        print("  PUBLIC_WEBHOOK_URL not set — skip webhook registration "
              "(re-run after starting ngrok and updating .env).")

    print("\nDone. Put these in backend/.env:")
    print(f"  AGENT_ID={agent.id}")
    print(f"  AGENT_PHONE_NUMBER={number.phone_number}")


if __name__ == "__main__":
    main()
