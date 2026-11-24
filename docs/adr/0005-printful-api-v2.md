# ADR-0005: Printful API v2, behind a thin adapter

- Status: Accepted
- Date: 2026-11-24
- Decided by: Klaus, 2026-11-24 ("ok, accept ADR-0005, use v2")

## Context

Printful API v2 is still labelled beta (since 2023-09); v1 works with no announced sunset. v2 provides per-placement print-area sizes and DPI, region availability and prices, explicit draft → confirmation orders, signed webhooks, a uniform rate-limit header scheme. Pressline chose v2-only for the same reasons. Printful has no sandbox: draft orders are never charged.

## Options considered

1. v2 for everything, behind our own small client module, with v1 calls only where v2 has a gap.
2. v1 only: stable, but fewer catalog details and unsigned webhooks.
3. A community SDK: the v2 one is marked inactive.

## Decision

Option 1, with a store-level private token whose scopes are limited to orders, file library and webhooks (and catalog reads). Known v1 call: cancelling a submitted order (`DELETE /orders/{id}`), because v2's DELETE only removes drafts.

## Consequences

- Beta changes may break us: contract tests against recorded responses, plus a daily catalog sync that fails loudly.
- Tokens expire and are rotated by hand (Klaus); the admin shows the token's expiry when the API reports it.
