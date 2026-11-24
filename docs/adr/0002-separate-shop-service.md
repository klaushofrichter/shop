# ADR-0002: Shop is a separate service, not part of art

- Status: Accepted
- Date: 2026-11-24
- Decided by: Klaus, 2026-11-24 (accepted with group 1: "yes, accept group 1")

## Context

art is a fast public gallery with no secrets, deployed as a Knative service. The shop holds payment state, customer addresses and API keys for Stripe and Printful, and runs background jobs (print files, order submission, polling).

## Options considered

1. **Separate repo and service** (`klaushofrichter/shop`, own namespace, own deploy). art only gets a link per picture and an internal endpoint for originals (ADR-0006).
2. **Shop inside art.** One deploy, but art would carry secrets, a database and a job runner, and every shop change would redeploy the gallery.

## Decision

Option 1. Proposed by Cluster, agreed by Shop.

## Consequences

- art keeps its security and performance profile; the shop's outages don't affect the gallery.
- Two changes in art's repo are needed (the link and the internal originals endpoint), done by art's owner session.
- The shop depends on art's public manifest format; a change there needs coordination (covered by an e2e check in the shop).

## Notes

- 2026-11-25: the internal originals endpoint mentioned in the consequences was dropped by ADR-0025; art's only change is the link.
