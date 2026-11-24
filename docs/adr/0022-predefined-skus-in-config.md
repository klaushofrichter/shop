# ADR-0022: A handful of predefined SKUs, defined in a config file

- Status: Accepted
- Date: 2026-11-24
- Decided by: Klaus, 2026-11-24: "It is acceptable to have a handful of pre-defined SKUs (a print of a given size, a T Shirt size M, postcards)."

## Context

The first goal described an admin that builds the SKU list from Printful's catalog. Klaus has since said a handful of predefined SKUs is enough. Pressline keeps its catalog in a typed config file validated at boot (its ADR-0014).

## Options considered

1. **SKUs in `config/skus.json`**, validated at startup and checked against Printful's live catalog (variant exists, print area and DPI match, available); adding one is a PR and a deploy.
2. A SKU editor in the admin that browses Printful's catalog: more UI, more validation, little value for a handful of SKUs.

## Decision

Option 1. The admin decides which SKUs each picture offers and at what price (ADR-0013), not which SKUs exist. Initial set in docs/design/04-catalog-and-print-files.md §2: postcard 4×6, art prints 8×10 and 16×20, framed prints 8×10 and 16×20 (black), mug 11 oz, t-shirt white S–XL.

## Consequences

- A new SKU needs a developer (or agent) change; acceptable at this scale.
- Each SKU maps to exactly one provider variant, which keeps print files and orders simple.

## Notes

- 2026-11-25: the initial set is replaced by ADR-0033 (sizes up to 12 × 16, both orientations).
