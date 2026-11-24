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

Recommendation changed 2026-11-24 to **option 1 (no gate, Stripe Radar only)**: an approval step is routine manual work, which Klaus ruled out ("the main objective is that this process is automated (no extra work by klaus)"). Revisit if fraudulent orders appear. Still Proposed: Klaus rejects or accepts.

## Consequences

- Large orders ship a little later. Abuse at small amounts is left to Radar.
