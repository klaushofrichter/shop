# ADR-0012: Sales tax and VAT

- Status: Accepted
- Date: 2026-11-24
- Decided by: Klaus, 2026-11-24: "We want to be able to pay sales tax as legally required."

## Context

Not tax advice; Klaus decides, ideally with a tax adviser. Facts: Stripe Tax computes and collects tax only where Klaus is registered (0.5% of volume through Checkout). A seller generally must collect sales tax in his home state (if it taxes these goods) from the first sale, and in other states after passing their economic-nexus threshold (commonly $100,000 or 200 transactions a year). EU/UK VAT applies to goods shipped there. Separately, Printful charges Klaus sales tax on its wholesale price unless he files resale certificates, and EU VAT unless he has a VAT id.

## Options considered

1. **Stripe Tax on, registered in the home state** (and later where thresholds are crossed); prices shown tax-exclusive in the US.
2. No tax collection at launch: only acceptable if Klaus confirms he has no obligation.
3. Prices tax-inclusive (common in the EU), Stripe Tax computes the tax portion.

## Decision

Option 1. The shop collects US sales tax through **Stripe Tax** (`automatic_tax`, tax-exclusive prices, tax codes per product kind and on shipping) in every state where Klaus is registered, records the tax per order and line, and exports it by period and state for filing. Which states require registration, the registration itself, the resale certificate at Printful and the filing are Klaus's (with his adviser); the steps are in docs/research/sales-tax.md §5. At the expected volume only the home state is likely to require registration. EU/UK VAT is out of scope while shipping is US-only (ADR-0011).


## Consequences

- Each Checkout line item gets a tax code (to verify: general tangible goods vs printing vs clothing).
