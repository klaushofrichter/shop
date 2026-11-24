# ADR-0036: Address and cost checks before payment, without Printful's estimation task

- Status: Proposed
- Date: 2026-11-25, revised 2026-11-26 after review round 2
- Decided by: (pending, Klaus; round-2 decision 8)

## Context

Round 1 added a Printful order-estimation task to every quote. The second capture showed it rejects only state/ZIP mismatches (no street validation), and it costs a POST plus polls, breaking the < 3 s quote target (review 2 F6). Review 1 F9 wanted the cost guard before payment instead of a refund after.

## Decision

- Address: required fields plus a static ZIP-prefix ↔ state table, locally, built from USPS's prefix list with the documented cross-state exceptions as tests; unknown prefixes accepted; rejections counted in the admin (review C F16).
- Shipping: one `POST /v2/shipping-rates` per quote.
- Cost: the estimated provider cost from cached wholesale prices (daily catalog refresh) + the quoted shipping + an allowance for Printful's tax on wholesale; if the margin after Stripe's fee falls below `MARGIN_FLOOR_CENTS`, Pay isn't offered and Klaus is alerted.
- The exact cost guard after payment (on the draft's real costs) stays as the backstop.

## Consequences

- One Printful call per quote; < 3 s holds.
- A wrong street still surfaces only as a returned parcel (accepted at this volume).
