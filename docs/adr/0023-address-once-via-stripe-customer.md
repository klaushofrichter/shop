# ADR-0023: The address is entered once, on the shop's page, and passed to Stripe as a Customer

- Status: Accepted
- Date: 2026-11-24
- Decided by: Klaus, 2026-11-24: "other: as recommended"

## Context

Shipping cost depends on the address, so the shop asks for it before the quote (ADR-0007). Stripe's hosted Checkout cannot prefill a shipping address it collects itself, and if it collected one, the customer could enter a different address than the one quoted. Stripe Tax needs the customer's address.

## Options considered

1. **Create a Stripe Customer per order** with the quoted address as `shipping` and `address`, pass it to the Checkout Session, and do **not** set `shipping_address_collection`. The customer types the address once; the paid address is the quoted address by construction; Stripe Tax uses it.
2. Let Checkout collect the address again (restricted to the quoted country) and compare after payment; a mismatch goes to manual review. Double typing, and a manual case.
3. Embedded Checkout with dynamic shipping: address once, but no Apple Pay / Google Pay and more client code.

## Decision

Option 1. To verify in Stripe test mode: that a fixed `shipping_options` entry works without `shipping_address_collection` (fallback: shipping as a line item), and that Stripe Tax takes the Customer's address.

## Consequences

- One Stripe Customer per order (no accounts); a little clutter in the Stripe Dashboard.
- The restricted key needs Customers write.
- The customer can't change the address on Stripe's page; they go back to the shop's address form (a link on the quote page).
