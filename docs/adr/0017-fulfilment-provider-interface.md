# ADR-0017: A fulfilment-provider interface; Printful first, Prodigi to evaluate for framed prints

- Status: Proposed
- Date: 2026-11-24
- Decided by: (pending, Klaus)

## Context

Printful has the best API and does mugs, t-shirts and postcards well, but few fine-art papers and basic framing. Prodigi is the provider most recommended for archival giclée prints and framing (frame colours, mounts, glazing) and has a sandbox; Gelato has local production with basic framing. These comparisons come from review sites, several written by the vendors ([research](../research/oss-learnings.md#prodigi-and-gelato)). Medusa's fulfilment providers show the usual interface shape.

## Options considered

1. **Printful only**, code written directly against it.
2. **A small provider interface from the start** (catalog variants, print-area spec, shipping quote, create order idempotently, confirm, cancel, fetch status, parse webhook), with Printful as the only implementation at launch; each SKU names its provider. Order sample framed prints from Printful and Prodigi and decide on quality.
3. Prodigi for everything: weaker for mugs and apparel.

## Decision

Option 2 proposed. The interface adds little code because the Printful adapter exists anyway (ADR-0005).

## Consequences

- A cart may contain items for two providers: one provider order per provider, each with its own shipping charge. Until a second provider exists, this stays theoretical.
- Sample orders (a few dollars each plus shipping) are Klaus's cost decision.
