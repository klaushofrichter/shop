# ADR-0020: Hold orders above an amount for Klaus's approval

- Status: Proposed
- Date: 2026-11-24
- Decided by: (pending, Klaus)

## Context

Framed prints are the most expensive items and a target for stolen cards; a chargeback costs the sale, the Printful cost and a dispute fee. Stripe Radar screens payments by default. PhotoPortfolio auto-approves orders below a set amount and holds larger ones; Pressline plans the same ("Review Mode").

## Options considered

1. No gate: Radar only.
2. **Hold paid orders above an amount** (proposed: $250) in `awaiting_approval`; Klaus approves or refunds in the admin; reminder after 24 h.
3. Hold every order: safe but not "fully automatic".

## Decision

Option 2 proposed; the amount is Klaus's. Setting it to 0 turns the gate off.

## Consequences

- Large orders ship a little later. Abuse at small amounts is left to Radar.
