"""Build the per-call system prompt from behavior.md + deterministic playbook.

No LLM call here — fast and deterministic.
"""
import re
from pathlib import Path

from strategy import get_concern_playbook

_PROMPTS_DIR = Path(__file__).parent / "prompts"
_BEHAVIOR_PATH = _PROMPTS_DIR / "behavior.md"
_BRAND_BRIEF_PATH = _PROMPTS_DIR / "brand_brief.md"

# Match discount codes in brand_brief.md, in either format:
#   - Table row:   | 1 | **10% off** | `SAYA10` | ...
#   - Header form: ### Tier 1 — 10% off (`SAYA10`)
#   - Inline list: - 10% off → code: SAYA10
# Liberal: any "N% off ... `CODE`" pair on the same span wins.
_DISCOUNT_CODE_RE = re.compile(
    r"(\d{1,3})\s*%\s*off[^`\n]{0,80}`([A-Z0-9_\-]+)`",
    re.IGNORECASE,
)


def _extract_discount_codes() -> list[tuple[int, str]]:
    """Parse discount codes from brand_brief.md.

    Matches any of:
      | 1 | **10% off** | `SAYA10` | ...
      ### Tier 1 — 10% off (`SAYA10`)
      - 10% off → code: `SAYA10`

    Returns a list of (percent, code) tuples in declaration order, deduped.
    Empty list if brand_brief.md doesn't exist or has no parseable codes.
    """
    if not _BRAND_BRIEF_PATH.exists():
        return []
    text = _BRAND_BRIEF_PATH.read_text()
    seen: set[int] = set()
    out: list[tuple[int, str]] = []
    for pct_str, code in _DISCOUNT_CODE_RE.findall(text):
        pct = int(pct_str)
        if pct in seen:
            continue
        seen.add(pct)
        out.append((pct, code))
    return out


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

    # Pull discount codes from brand_brief.md (parsed from the discount-tier
    # table) so Sarah can read them aloud as a fallback if the SMS payment
    # link can't be delivered (e.g. 10DLC block).
    codes = _extract_discount_codes()
    if codes:
        codes_block = "Discount codes (read aloud as backup if SMS doesn't go through):\n"
        for pct, code in codes:
            codes_block += f"  - {pct}% off → code: {code}\n"
        codes_block += (
            "When you offer a discount, also tell her the code verbally: "
            '"I\'m texting you the link now, and just in case it doesn\'t come through, '
            'you can use code [CODE] at checkout." Read the code letter by letter — '
            'TTS can mangle short alphanumeric strings ("S-A-Y-A, ten").\n'
        )
    else:
        codes_block = ""

    context_block = (
        "# CONTEXT FOR THIS CALL\n\n"
        f"Customer: {name or 'unknown'}\n"
        f"What's in her cart: {items_str}\n"
        f"Cart total: {total:,}\n\n"
        f"Leading hypothesis (what likely got in the way): {playbook['concern']}\n\n"
        f"Probing question shape for Step 2: ask if it was about {playbook['probe']} "
        "— or if it was something else.\n\n"
        f"Suggested approach for Step 3 if she confirms this concern:\n{playbook['approach']}\n"
        + (f"\n{codes_block}" if codes_block else "")
    )

    system_prompt = behavior + "\n\n" + context_block

    opening = (
        f"Hi — is this {first_name}?" if first_name else "Hi — is this Shanzila?"
    )

    return system_prompt, opening, context_block
