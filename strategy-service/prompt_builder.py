"""Build the per-call system prompt from behavior.md + deterministic playbook.

No LLM call here — fast and deterministic.
"""
from pathlib import Path

from strategy import get_concern_playbook

_BEHAVIOR_PATH = Path(__file__).parent / "prompts" / "behavior.md"


def build_call_prompt(session: dict) -> tuple[str, str, str]:
    """Build (system_prompt, opening_greeting, context_block).

    - `system_prompt`: behavior.md + a CONTEXT FOR THIS CALL block with
      customer + cart + leading hypothesis + probe + suggested approach.
    - `opening_greeting`: the literal first line the agent speaks ("Hi — is this Shanzila?").
    - `context_block`: just the per-call context section, so the dashboard
      can display what the agent was told about this call.

    behavior.md is read fresh on every call so dashboard edits land instantly.
    """
    behavior = _BEHAVIOR_PATH.read_text()
    playbook = get_concern_playbook(session)

    customer = session.get("customer", {}) or {}
    cart = session.get("cart", {}) or {}

    name = (customer.get("name") or "").strip()
    first_name = name.split()[0] if name else None

    items = cart.get("items", []) or []
    items_str = ", ".join((it.get("name") or "?") for it in items) or "(empty)"
    total = cart.get("total", 0)

    context_block = (
        "# CONTEXT FOR THIS CALL\n\n"
        f"Customer: {name or 'unknown'}\n"
        f"What's in her cart: {items_str}\n"
        f"Cart total: {total:,}\n\n"
        f"Leading hypothesis (what likely got in the way): {playbook['concern']}\n\n"
        f"Probing question shape for Step 2: ask if it was about {playbook['probe']} "
        "— or if it was something else.\n\n"
        f"Suggested approach for Step 3 if she confirms this concern:\n{playbook['approach']}\n"
    )

    system_prompt = behavior + "\n\n" + context_block

    opening = (
        f"Hi — is this {first_name}?" if first_name else "Hi — is this Shanzila?"
    )

    return system_prompt, opening, context_block
