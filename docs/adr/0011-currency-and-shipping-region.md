# ADR-0011: Currency USD, shipping region to decide

- Status: Accepted
- Date: 2026-11-24
- Decided by: Klaus, 2026-11-24: "other: as recommended"

## Context

art prices originals in USD. Printful ships worldwide from several fulfilment centres; tax obligations (ADR-0012) grow with each region.

## Options considered

1. **USD, ship to the US only** at first: simplest tax picture.
2. **USD, ship to US, Canada, EU, UK**: Printful fulfils locally in the EU and UK; EU/UK VAT then applies (ADR-0012).
3. Worldwide.

## Decision

Option 1: USD, shipping to the United States only at launch. Widen when tax registration for the next region is settled (each widening is a new ADR).

## Consequences

- The allowed countries are an admin setting; Stripe Checkout restricts to the quoted country.

## Notes

- 2026-11-25: Checkout no longer restricts `allowed_countries` (ADR-0023); the shop's address form offers only the enabled countries.
