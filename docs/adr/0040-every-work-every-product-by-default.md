# ADR-0040: Every work and every product by default; prices per product

- Status: Accepted
- Date: 2026-11-25
- Decided by: Klaus, 2026-11-25: "we print what the customer selects in art.klaushofrichter.net … we offer all content for all SKUs at the beginning", and "its pricing per SKU, and not per artwork/image. We may change that later."

## Context

ADR-0035 made consent to print a per-work allow-list (`printsAllowedWorks`), empty until Klaus named works, and the admin had to enable each work and each product by hand. Art is Klaus's own work, and he wants the shop to sell any picture the customer chooses there. He wants a tool that ties products to individual pictures later; until then, every picture gets every product. Prices are per product.

## Options considered

1. Keep the per-work allow-list and manual offers: nothing sells until Klaus has made about 275 decisions (25 works × 11 products).
2. Everything on by default, with the admin's switches kept for exceptions (chosen).

## Decision

- art's `printsAllowedDefault` is `true` in `config/sources.json`. A source's own per-work flag, if it ever publishes one, still wins (ADR-0035).
- A new work that may be printed starts enabled.
- Once its original is checked, every SKU whose print reaches the DPI floor gets an enabled offer, with a centre crop and the SKU's price, and a render.
- Existing offers and work switches are left as they are, so anything the admin switched off stays off.
- Prices come only from `config/skus.json`. The admin's work page shows the price but no longer edits it per work. The `price_cents` column stays, for a later per-work price.

## Consequences

- Every work is rendered once per product, registered at Printful, and gets a mockup. At about 25 works and 11 products, that is roughly 275 print files on the volume (a few GB) and mockups at one per 30 s, so about 2½ hours on the first start.
- A product whose print would fall below the DPI floor is not offered for that work. It is offered after a larger original arrives.
- Amends ADR-0035 (the allow-list stays available for other sources) and the work page in docs/design/08.
- Revisit when the product-to-picture editor is built, or when Klaus wants prices per work.
