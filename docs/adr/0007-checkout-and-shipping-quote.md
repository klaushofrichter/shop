# ADR-0007: Stripe hosted Checkout, shipping quoted on the shop's own page

- Status: Proposed
- Date: 2026-11-24
- Decided by: (pending, Klaus)

## Context

Shipping cost comes from Printful and depends on the address and the cart. Stripe's hosted Checkout page cannot change shipping options after the customer enters the address there (checked in Stripe's docs 2026-11-24: "The full embedded page and full hosted page don't support dynamically customizing shipping options"). Dynamic shipping exists only for the embedded form and Elements, and it disables Apple Pay and Google Pay.

## Options considered

1. **Address on the shop's page first**, shipping rates from Printful, then a hosted Checkout Session with that shipping as a fixed option and `allowed_countries` set to the quoted country; after payment, compare the entered address with the quote. The customer types the address twice unless we prefill (Checkout can prefill email, not the address, for a new customer).
2. **Embedded Checkout form with dynamic shipping.** Address once, shipping recomputed by our server, but no Apple Pay / Google Pay, more client code, and Stripe's form inside our page.
3. **Flat shipping per product and region**, set in the admin, with hosted Checkout and no Printful rate call before payment. Simplest for the customer; the margin absorbs the difference.

## Decision

Option 1 (proposed). Option 3 is a sensible simplification if Klaus prefers fewer steps; the admin's margin view shows what flat rates would cost.

## Consequences

- No card data on our side (PCI SAQ A), wallets keep working.
- An address mismatch between quote and payment sends the order to needs_attention.
