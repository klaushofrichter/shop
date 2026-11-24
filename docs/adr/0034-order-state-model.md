# ADR-0034: Separate payment, fulfilment and dispute state; holds with deadlines; invariants

- Status: Proposed
- Date: 2026-11-25, revised 2026-11-26 after review round 2
- Decided by: (pending, Klaus; round-2 decision 1)

## Context

Round 1 had one `state` column. Review 1 (F1, F4, F5, F8) and review 2 (F5) showed its gaps: a payment arriving on an order the shop had closed had no legal edge; a refund made in the Stripe Dashboard made the order terminal while Printful still shipped; `needs_attention` forgot where the order was; holds had no deadline mechanism. Round 2 (reviews A–D) found that a read can't prove Printful won't charge, that a partial refund would cancel the order, that attempts, disputes and failed refunds had no defined way on, that a restart could skip the fail-safes, and that orders never ended.

## Decision

docs/design/07 §2:
- An order has `payment_state`, `fulfilment_state` (mirroring the newest submission attempt) and `dispute_state`, plus **holds** (kind, all reasons, deadline, an action computed per reason, resolution) and **refunds** as records. The customer status is derived.
- Payment is applied in **one transaction** with every fail-safe and the hold or the submit job (`failsafe_checked_at`).
- **A successful delete is the proof** before an automatic refund: every attempt never created, `canceled`, or deleted now through v2 `DELETE` (allowed only for uncharged orders); a quiet period after an unanswered confirm.
- **Only a full refund cancels**; a partial refund is recorded.
- Events and holds are attempt-aware; a cancel the shop issued never opens a refund hold; at most 3 attempts.
- Orders **complete** (delivered; shipped and a configured time passed; fully refunded with nothing live; never paid; test draft; dispute closed); completion ends polling and starts retention.
- Invariants I1–I11 are enforced in code and tested with random sequences, restarts included, against the mocks.

## Consequences

- Replaces the single state machine of round 1; fewer special edges.
- Reconciliation follows fulfilment until completion and enforces I10 (every paid, incomplete order has an owner).
- Reshipments are made in Printful's dashboard and linked to the order from the reverse sweep's alarm; the shop has no reship action.
