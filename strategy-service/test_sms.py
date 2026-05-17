"""Send a single test SMS via AgentPhone — sanity check before wiring the webhook handler.

Usage:
    python test_sms.py +16502487860            # send to that number
    python test_sms.py                          # interactive — prompts for number
"""
import os
import sys

from dotenv import load_dotenv

load_dotenv()


def main():
    api_key = os.getenv("AGENTPHONE_API_KEY")
    agent_id = os.getenv("AGENT_ID")
    if not api_key:
        raise SystemExit("AGENTPHONE_API_KEY not set in .env")
    if not agent_id:
        raise SystemExit("AGENT_ID not set in .env")

    if len(sys.argv) >= 2:
        to_number = sys.argv[1].strip()
    else:
        to_number = input("Phone number (E.164, e.g. +16502487860): ").strip()
    if not to_number.startswith("+"):
        raise SystemExit(f"Phone number must be E.164 format (starts with +). Got: {to_number!r}")

    body = "Test SMS from Saya 🌸"

    print("=" * 60)
    print(f"agent_id: {agent_id}")
    print(f"to:       {to_number}")
    print(f"body:     {body}")
    print("=" * 60)

    from agentphone import AgentPhone
    client = AgentPhone(api_key=api_key)

    try:
        result = client.messages.send(
            agent_id=agent_id,
            to_number=to_number,
            body=body,
        )
    except Exception as e:
        print(f"\n❌ FAILED: {type(e).__name__}: {e}")
        raise

    print(f"\n✅ SMS sent.")
    print(f"raw response: {result!r}")
    if isinstance(result, dict):
        msg_id = result.get("id") or result.get("message_id")
        status = result.get("status")
        if msg_id:
            print(f"message_id:   {msg_id}")
        if status:
            print(f"status:       {status}")


if __name__ == "__main__":
    main()
