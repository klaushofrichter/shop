# ADR-0010: Order failures after payment: retry, then Klaus, then refund

- Status: Accepted
- Date: 2026-11-24
- Decided by: Klaus, 2026-11-24: "other: as recommended"

## Context

The risky case is: payment succeeded, Printful order failed (address rejected, print file problem, out of stock, Printful billing failed, API down).

## Options considered

1. **Retry automatically for 24 h**, then `needs_attention` with an email to Klaus; he fixes and resubmits or refunds from the admin. If still unresolved after 72 h, **refund in full automatically** and email the customer.
2. Same, but never refund automatically: every refund is Klaus's click.
3. Refund automatically at the first permanent failure.

## Decision

Option 1, with the windows as proposed: retries for 24 h; automatic full refund after 72 h on a Printful billing hold and 24 h after a cost-guard stop; permanent failures refund at once. Updated 2026-11-24 after Klaus's requirement that the process be fully automated with no routine work for him (R9): every exception has a timer that ends in an automatic refund if he doesn't act, and permanent failures (invalid address, discontinued variant) refund at once. Details: docs/design/06-fulfilment.md §7.

## Consequences

- A customer never waits indefinitely for a paid order. Stripe keeps its fee on refunds.
- Printful cancellations (`order_canceled`) and refunds (`order_refunded`, a credit to Klaus's Printful wallet) also land in needs_attention; refunding the customer stays Klaus's decision there.
- A cost guard stops confirmation when Printful's estimate exceeds what the customer paid (minus a margin floor).
