"""Text playground — chat with Sarah locally without AgentPhone.

Uses the SAME pipeline as the live call: brand brief → strategy briefing →
behavior.md → per-call system prompt. You play the customer, Sarah responds.

Run:
    python playground.py            # uses a default Saaya session
    python playground.py --session path/to/session.json
    python playground.py --no-briefing   # skip strategy step (raw behavior only)

Commands inside the REPL:
    /reload     reload behavior.md + strategy_system.md + brand_brief.md
    /briefing   re-generate the briefing for the current session
    /system     dump the assembled system prompt
    /reset      start a new conversation (same system prompt)
    /quit       exit
"""
import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

from dotenv import load_dotenv
load_dotenv()

from anthropic import AsyncAnthropic

from strategy import generate_briefing
from prompt_builder import build_call_prompt

DEFAULT_SESSION = {
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
        "reason": "tab-hidden",
        "shippingCostShock": False, "discountCodeFailed": False,
        "trustHesitation": False, "returningVisitor": False,
    },
    "saaya": {"country": "US", "city": "San Francisco", "shippingName": "United States",
              "shippingDays": "7–12 business days", "paymentMethod": "card"},
    "timestamp": "2026-05-17T21:45:00Z",
}


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--session", help="path to a session.json")
    parser.add_argument("--no-briefing", action="store_true", help="skip strategy generation")
    parser.add_argument("--model", default="claude-sonnet-4-5")
    args = parser.parse_args()

    session = json.loads(Path(args.session).read_text()) if args.session else DEFAULT_SESSION
    client = AsyncAnthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))

    async def build_system():
        if args.no_briefing:
            briefing = "(briefing skipped — using behavior.md only)"
        else:
            print("\n… generating briefing", end="", flush=True)
            briefing = await generate_briefing(session)
            print(" ✓\n")
        system_prompt, opening = build_call_prompt(session, briefing)
        return system_prompt, opening, briefing

    system_prompt, opening, briefing = await build_system()
    messages: list[dict] = []

    print("=" * 72)
    print("PLAYGROUND — chatting with Sarah from Saaya")
    print(f"Customer: {session['customer']['name']} · cart {session['cart']['total']:,}")
    print("=" * 72)
    print(f"\nSarah: {opening}\n")
    messages.append({"role": "assistant", "content": opening})

    while True:
        try:
            user_input = input("You: ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\nbye.")
            return

        if not user_input:
            continue

        if user_input.startswith("/"):
            cmd = user_input.lower()
            if cmd in ("/quit", "/exit", "/q"):
                print("bye.")
                return
            if cmd == "/reset":
                messages = [{"role": "assistant", "content": opening}]
                print(f"\n(conversation reset)\nSarah: {opening}\n")
                continue
            if cmd == "/reload":
                # Re-import strategy + prompt_builder to pick up edits.
                import importlib, strategy as _strategy, prompt_builder as _pb
                importlib.reload(_strategy)
                importlib.reload(_pb)
                from strategy import generate_briefing as _gb
                from prompt_builder import build_call_prompt as _bcp
                globals()["generate_briefing"] = _gb
                globals()["build_call_prompt"] = _bcp
                system_prompt, opening, briefing = await build_system()
                messages = [{"role": "assistant", "content": opening}]
                print(f"\n(prompts reloaded — conversation reset)\nSarah: {opening}\n")
                continue
            if cmd == "/briefing":
                print("\n--- BRIEFING ---")
                print(briefing)
                print("--- END ---\n")
                continue
            if cmd == "/system":
                print("\n--- SYSTEM PROMPT ---")
                print(system_prompt)
                print("--- END ---\n")
                continue
            print(f"(unknown command {user_input})")
            continue

        messages.append({"role": "user", "content": user_input})

        try:
            response = await client.messages.create(
                model=args.model,
                max_tokens=400,
                system=system_prompt,
                messages=messages,
            )
        except Exception as e:
            print(f"(API error: {e})")
            messages.pop()  # drop the user turn so we can retry
            continue

        reply = next((b.text for b in response.content if b.type == "text"), "").strip()
        messages.append({"role": "assistant", "content": reply})
        print(f"\nSarah: {reply}\n")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
