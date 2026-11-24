# ADR-0011: Currency USD, shipping region to decide

- Status: Proposed
- Date: 2026-11-24
- Decided by: (pending, Klaus)

## Context

art prices originals in USD. Printful ships worldwide from several fulfilment centres; tax obligations (ADR-0012) grow with each region.

## Options considered

1. **USD, ship to the US only** at first: simplest tax picture.
2. **USD, ship to US, Canada, EU, UK**: Printful fulfils locally in the EU and UK; EU/UK VAT then applies (ADR-0012).
3. Worldwide.

## Decision

Pending. Recommendation: start with option 1 and widen when tax registration for the next region is settled.

## Consequences

- The allowed countries are an admin setting; Stripe Checkout restricts to the quoted country.
