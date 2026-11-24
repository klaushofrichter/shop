# ADR-0010: Order failures after payment: retry, then Klaus, then refund

- Status: Accepted; amended 2026-11-26 (billing holds never refund by timer, ADR-0034)
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

## Notes

- 2026-11-25: Printful cancellations refund automatically when ADR-0034's invariant I4 allows (a fresh read shows Printful can't charge); otherwise Klaus is alerted. Holds replace `needs_attention` (ADR-0034).
- 2026-11-26, **amendment accepted** by Klaus (round-2 decision 6, "decisions 1, 2, 4, 6, 7, 8, 9: ok"; superseded in part by ADR-0034): on a Printful billing hold (any provider hold) the shop **never refunds by timer**; it alerts at once and daily. Printful would charge and ship once billing is fixed, so a timer refund could pay the customer back for an order that still arrives. An automatic refund after a Printful cancel or failure needs a successful delete or a `canceled` read (ADR-0034, I4). The 24 h retry window is `PROVIDER_RETRY_WINDOW_HOURS`; after it a hold whose deadline refunds only if I4 allows.
