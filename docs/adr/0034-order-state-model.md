# ADR-0034: Separate payment, fulfilment and dispute state; holds with deadlines; invariants

- Status: Proposed
- Date: 2026-11-25
- Decided by: (pending, Klaus; for review round 2)

## Context

Round 1 had one `state` column. Review 1 (F1, F4, F5, F8) and review 2 (F5) showed its gaps: a payment arriving on an order the shop had closed had no legal edge; a refund made in the Stripe Dashboard made the order terminal while Printful still shipped; `needs_attention` forgot where the order was; holds had no deadline mechanism.

## Decision

docs/design/07 §2: an order has `payment_state`, `fulfilment_state` and `dispute_state`; exceptions are **holds** (kind, all reasons, deadline, action, resolution); the customer status is derived. Invariants I1–I9 (a paid session always wins; fulfilment only when paid and unheld; confirm at most once with `confirm_requested_at` written first; an automatic refund only after a fresh read shows the provider can't charge; a new attempt only after the previous one is proven cancelled; fulfilment followed to its end regardless of payment; any refund cancels or alerts; the amount equals the quote; one open checkout per cart) are enforced in code and tested with random sequences against the mocks.

## Consequences

- Replaces the single state machine of round 1; fewer special edges.
- Reconciliation follows fulfilment until a provider end state.
