# ADR-0033: Launch sizes up to 12 × 16 in, landscape and portrait

- Status: Accepted
- Date: 2026-11-25
- Decided by: Klaus, 2026-11-25: "For launch, we can offer smaller size, e.g. 12x9 - consider landscape and portrait aspect ratio"

## Context

Round 1's 16 × 20 sizes reach only 144–189 DPI from art's 12 MP originals (review 1 F22). Printful has no 9 × 12; its 6 × 8 and 12 × 16 are exactly 3:4, the shape of the iPhone photos, and 8 × 10 (4:5) suits the paintings.

## Decision

Launch SKUs (docs/design/04 §2): postcard 4 × 6; art prints 6 × 8, 8 × 10, 12 × 16; framed prints (black) 8 × 10 and 12 × 16; mug 11 oz; t-shirt white S–XL. Every size is offered in portrait and landscape, following the work. Paper `minDpi` 180; every measured original reaches it at 12 × 16 (181–252 DPI). 16 × 20 and larger are deferred.

## Consequences

- Replaces the initial SKU set named in ADR-0022 (the mechanism of ADR-0022 stands).
- Landscape is verified with one draft in the test store before the item mapper is written.
