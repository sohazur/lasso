"""Stripe payment link generation for closed-call follow-up."""
import os

import stripe

stripe.api_key = os.getenv("STRIPE_SECRET_KEY")


def create_payment_link(
    amount_cents: int,
    product_name: str,
    customer_email: str | None = None,
) -> str:
    """Create a Stripe Payment Link for an ad-hoc amount.

    Stripe Payment Links require an existing Price object, so we create one
    on the fly with `product_data` for the product name. Returns the link URL.
    """
    price = stripe.Price.create(
        unit_amount=amount_cents,
        currency="usd",
        product_data={"name": product_name},
    )

    link_params: dict = {"line_items": [{"price": price.id, "quantity": 1}]}
    if customer_email:
        link_params["metadata"] = {"customer_email": customer_email}

    link = stripe.PaymentLink.create(**link_params)
    return link.url
