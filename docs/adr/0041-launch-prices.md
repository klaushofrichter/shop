# ADR-0041: Launch prices

- Status: Accepted
- Date: 2026-11-25
- Decided by: Klaus, 2026-11-25: "I approve the placeholders for the prices"

## Context

`config/skus.json` carried placeholder retail prices, marked `placeholderPrice`, which a live start refuses (ADR-0033). Prices are per product, not per work (ADR-0040). Before deciding, Klaus saw Printful's wholesale prices: those captured on 2026-11-24, and estimates for the variants not captured. He also saw each product's break-even after Printful's sales tax on wholesale and Stripe's fee.

## Decision

The launch prices are the former placeholders, now final:

| SKU | Price |
|---|---|
| postcard-4x6 | $4.00 |
| print-6x8 | $25.00 |
| print-8x10 | $32.00 |
| print-12x16 | $45.00 |
| framed-8x10-black | $59.00 |
| framed-12x16-black | $79.00 |
| mug-11oz | $18.00 |
| tshirt-white-s, -m, -l, -xl | $26.00 each |

Shipping is charged at Printful's rate (`SHIPPING_MARKUP_CENTS` 0); sales tax comes from Stripe Tax (ADR-0012).

## Consequences

- The `placeholderPrice` marks are removed; the live-mode check stays for any future SKU added with a placeholder.
- The pre-payment cost check and the cost guard (05 §2, 06 §4) still refuse a sale below cost if Printful's prices rise; the admin's work page shows the current wholesale price per product.
- A price change is a change to `config/skus.json` and a deploy, decided by Klaus.
