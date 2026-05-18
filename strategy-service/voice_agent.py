"""Webhook-mode voice agent — Claude drives the conversation loop.

Called from `/api/voice` in main.py. Receives the per-call CONTEXT (cart,
customer, hypothesis playbook), recent conversation history, and runs an
inner tool-use loop with Claude to produce the next spoken response.

Returns a dict:
  { "text": "...", "action": "transfer" | None }
"""
from __future__ import annotations

import json
import os
from pathlib import Path

from anthropic import AsyncAnthropic

from prompt_builder import build_call_prompt
import stripe_client

_client = AsyncAnthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))


TOOLS = [
    {
        "name": "send_payment_link",
        "description": (
            "Send the customer an SMS with a Stripe payment link. Use this "
            "when the customer has agreed to purchase AND you've confirmed "
            "the final price (including any discount). The SMS goes out "
            "automatically as the call wraps up — your spoken response in "
            "this same turn should tell the customer you're texting the link."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "final_total": {
                    "type": "number",
                    "description": "Final total in dollars (or PKR), with any discount applied.",
                },
                "discount_summary": {
                    "type": "string",
                    "description": "Brief description of any discount, e.g. '10% off' or 'free expedited shipping'. Use 'no discount' if none.",
                },
            },
            "required": ["final_total"],
        },
    },
    {
        "name": "transfer_to_founder",
        "description": (
            "Transfer the call to the founder. Use ONLY for situations the "
            "agent genuinely cannot resolve: custom alteration requests, "
            "exception decisions, urgent issues outside the playbook. Do "
            "NOT use for routine objections like price, shipping, or fit — "
            "handle those yourself with the concession ladder."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "reason": {
                    "type": "string",
                    "description": "Why you're transferring — for logs.",
                },
            },
            "required": ["reason"],
        },
    },
]


async def run_claude_with_tools(
    *,
    system_prompt: str,
    messages: list[dict],
    call_id: str,
    session: dict,
    call_contexts: dict,
    max_iterations: int = 3,
) -> dict:
    """Run the Claude conversation loop with tool-use, until a final text response.

    Returns: {"text": str, "action": "transfer" | None}
    """
    conversation = list(messages)
    transfer_pending = False

    for _ in range(max_iterations):
        try:
            response = await _client.messages.create(
                model="claude-sonnet-4-5",   # Haiku regressed call quality; staying on Sonnet
                max_tokens=400,
                system=system_prompt,
                tools=TOOLS,
                messages=conversation,
            )
        except Exception as e:
            print(f"⚠️  Claude API error: {e}")
            return {"text": "Sorry, give me one moment — I'm having trouble on my end.", "action": None}

        if response.stop_reason == "tool_use":
            conversation.append({"role": "assistant", "content": response.content})
            tool_results = []
            for block in response.content:
                if block.type != "tool_use":
                    continue
                try:
                    result_text = await _execute_tool(
                        block.name, block.input, call_id, session, call_contexts
                    )
                except Exception as e:
                    print(f"⚠️  Tool {block.name} failed: {e}")
                    result_text = f"Tool error: {e}"
                if block.name == "transfer_to_founder":
                    transfer_pending = True
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": result_text,
                })
            conversation.append({"role": "user", "content": tool_results})
            continue

        # Final text response
        final_text = " ".join(b.text for b in response.content if getattr(b, "type", None) == "text").strip()
        if not final_text:
            final_text = "Okay."
        return {"text": final_text, "action": "transfer" if transfer_pending else None}

    return {
        "text": "Let me check on that and get back to you shortly.",
        "action": "transfer" if transfer_pending else None,
    }


async def _execute_tool(name: str, args: dict, call_id: str, session: dict, call_contexts: dict) -> str:
    """Execute a single tool call. Return a short text result that Claude can
    incorporate into its spoken response."""
    if name == "send_payment_link":
        final_total = float(args["final_total"])
        discount = args.get("discount_summary", "no discount")

        items = session.get("cart", {}).get("items", [])
        product_name = f"Saaya order — {len(items)} item{'s' if len(items) != 1 else ''}"

        try:
            stripe_url = stripe_client.create_payment_link(
                amount_cents=int(round(final_total * 100)),
                product_name=product_name,
                customer_email=session.get("customer", {}).get("email"),
            )
        except Exception as e:
            print(f"⚠️  Stripe link generation failed: {e}")
            return f"Stripe link generation failed: {e}. Tell the customer you'll text the link shortly once you sort it out."

        # Queue the SMS for the call_ended handler to actually send.
        call_contexts[call_id]["pending_sms"] = {
            "url": stripe_url,
            "total": final_total,
            "discount": discount,
        }
        print(f"💳 Stripe link queued for SMS (call {call_id}): {stripe_url} — total ${final_total} ({discount})")
        return f"Payment link ready for ${final_total} ({discount}). SMS goes out as the call wraps up."

    if name == "transfer_to_founder":
        reason = args.get("reason", "unspecified")
        print(f"📞 Transfer requested (call {call_id}): {reason}")
        call_contexts[call_id]["transfer_requested"] = reason
        return "Transfer ready. Tell the customer you're connecting them to the founder now, in one short sentence."

    return f"Unknown tool: {name}"
