"""Deterministic concern-playbook lookup. No LLM call.

Playbooks live in `prompts/playbooks.json` so they're editable from the
dashboard. Each call reads the JSON fresh from disk.
"""
import json
from pathlib import Path

_PLAYBOOKS_PATH = Path(__file__).parent / "prompts" / "playbooks.json"


def _load() -> dict:
    return json.loads(_PLAYBOOKS_PATH.read_text())


def get_concern_playbook(session: dict) -> dict:
    """Return the playbook for this session.

    Logic:
    1. If any `overrides.<flag>` is true in session.signals, that override wins.
    2. Otherwise look up by `exitPoint`, falling back to `playbooks.fallback`.
    """
    pb = _load()
    signals = session.get("signals", {}) or {}

    for flag, override_playbook in pb.get("overrides", {}).items():
        if signals.get(flag):
            return override_playbook

    by_exit = pb.get("by_exit_point", {})
    exit_point = signals.get("exitPoint") or pb.get("fallback", "order_review")
    if exit_point in by_exit:
        return by_exit[exit_point]
    return by_exit.get(pb.get("fallback", "order_review"), {})
