# ADR-0010: Order failures after payment: retry, then Klaus, then refund

- Status: Proposed
- Date: 2026-11-24
- Decided by: (pending, Klaus)

## Context

The risky case is: payment succeeded, Printful order failed (address rejected, print file problem, out of stock, Printful billing failed, API down).

## Options considered

1. **Retry automatically for 24 h**, then `needs_attention` with an email to Klaus; he fixes and resubmits or refunds from the admin. If still unresolved after 72 h, **refund in full automatically** and email the customer.
2. Same, but never refund automatically: every refund is Klaus's click.
3. Refund automatically at the first permanent failure.

## Decision

Option 1 proposed; the 24 h / 72 h windows are Klaus's to set.

## Consequences

- A customer never waits indefinitely for a paid order. Stripe keeps its fee on refunds.
- Printful cancellations (`order_canceled`) and refunds (`order_refunded`, a credit to Klaus's Printful wallet) also land in needs_attention; refunding the customer stays Klaus's decision there.
- A cost guard stops confirmation when Printful's estimate exceeds what the customer paid (minus a margin floor).
