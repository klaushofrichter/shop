# ADR-0026: A cart with products of any picture (supersedes ADR-0008)

- Status: Accepted
- Date: 2026-11-25
- Decided by: Klaus, 2026-11-25: "we lift the restriction which was meant to reduce complexity, but it is actually desired. We will need a cart, then."

## Context

ADR-0008 limited an order to products of one picture. Both design reviews pointed at its cost: two pictures meant two orders, two shipping charges and two Stripe fees, and the second order tripped the repeat-customer hold (ADR-0020), making Klaus a step in a normal purchase. Review 1 also noted the restriction costs code rather than saving it (the "replace your cart?" dialog).

## Decision

A cart holds products of any pictures (and, later, of any content source). The picture page stays the entry point; the cart is reachable from every page. One order, one Printful order, one shipping charge.

## Consequences

- Order items carry the source and picture per item (already in the schema); the cart page groups items by picture.
- The repeat-customer hold becomes cumulative (review 1 F7), so a normal second purchase isn't held.
- Mixed carts can ship in more than one parcel (paper and apparel come from different facilities); the status page and e-mails are per parcel (ADR-0027).
