# ADR-0012: Sales tax and VAT

- Status: Proposed
- Date: 2026-11-24
- Decided by: (pending, Klaus)

## Context

Not tax advice; Klaus decides, ideally with a tax adviser. Facts: Stripe Tax computes and collects tax only where Klaus is registered (0.5% of volume through Checkout). A seller generally must collect sales tax in his home state (if it taxes these goods) from the first sale, and in other states after passing their economic-nexus threshold (commonly $100,000 or 200 transactions a year). EU/UK VAT applies to goods shipped there. Separately, Printful charges Klaus sales tax on its wholesale price unless he files resale certificates, and EU VAT unless he has a VAT id.

## Options considered

1. **Stripe Tax on, registered in the home state** (and later where thresholds are crossed); prices shown tax-exclusive in the US.
2. No tax collection at launch: only acceptable if Klaus confirms he has no obligation.
3. Prices tax-inclusive (common in the EU), Stripe Tax computes the tax portion.

## Decision

Pending Klaus (and his adviser). Recommendation: option 1 together with ADR-0011 option 1, plus resale certificates at Printful for the home state.

## Consequences

- Each Checkout line item gets a tax code (to verify: general tangible goods vs printing vs clothing).
