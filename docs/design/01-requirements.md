# 1. Requirements

## 1. Purpose

Let visitors of `art.klaushofrichter.net` (and later other galleries) buy reproductions of the works they see
there (postcards, prints, framed prints, mugs, t-shirts) in a shop at
`shop.klaushofrichter.net`, with payment, production, shipping and tracking fully
automated through Stripe and Printful.

## 2. Actors

| Actor | Role |
|---|---|
| Visitor / customer | Browses art, buys in the shop, follows the order. No account. |
| Klaus (owner, admin) | Chooses what is offered at what price, gets told about exceptions. Signs in to `/admin` with Google. |
| Galleries (content sources) | art at launch: a public gallery of paintings and photographs whose manifest and originals are public. Later possibly christina-art or instagetter. |
| Stripe | Payment (hosted Checkout), optionally tax, refunds. |
| Printful | Production and shipping; bills Klaus's Printful account the wholesale cost per confirmed order. A separate **test store** for test mode. |
| Cluster session | Operates the k3s cluster: namespace, manifests, Secrets, backups. |

## 3. Minimum requirements

From Klaus, 2026-11-23 to 2026-11-25. Each has an id for tracing. Revised for review round 2.

| Id | Requirement |
|---|---|
| R1 | The customer selects a picture in a gallery (art at launch) and transitions to the shop with that picture as input. |
| R2 | In the shop the customer selects products (with quantities) from a predefined set and collects them in a **cart that may hold products of several pictures** (Klaus, 2026-11-25; ADR-0026). |
| R3 | A **handful of predefined SKUs** is enough (e.g. a print of a given size, a t-shirt size M, postcards). Adding one later is a small change. |
| R4 | The customer provides a shipping address and gets **quoted the costs** (items + shipping, and tax if applicable) before paying. |
| R5 | **Previews** of the products with the picture, from Printful's mockup generator where possible. |
| R6 | Payment is **redirected to Stripe** (the shop never handles card data). |
| R7 | After payment the order goes to **Printful for fulfilment** automatically. |
| R8 | The shop receives **shipping confirmation and tracking** from Printful, stores it, and **e-mails the customer** status updates and the tracking link per parcel (Klaus, 2026-11-25; ADR-0027). |
| R9 | **Fully automated**: no routine work for Klaus per order. He is involved only for exceptions the system cannot resolve, and never as a step in the happy path. |
| R10 | **Repeatable and scalable** in the sense of: adding a picture or a SKU is configuration, not code; the process works the same for every order. |
| R11 | Volume: **fewer than 10 orders a week** from real customers (an estimate, not a limit). Simplicity beats throughput. |
| R12 | An admin area (Google sign-in, Klaus only) to choose which works are offered, which SKUs each offers and at what price. Which works may be sold at all is the source's decision (art's, later; Klaus 2026-11-25), expressed as a per-work "prints allowed" flag. |
| R13 | A thin abstraction for fulfilment providers is acceptable (Printful now; another, e.g. Prodigi for fine-art prints, possible later). |
| R14 | Start in mock mode, then Stripe test mode with drafts in a separate Printful test store; go live only when Klaus says so (ADR-0029). |
| R15 | Follow the cluster's repository and deployment rules (ADR-0016). |
| R16 | **Fail-safes against large or unusual orders** (misuse, not real customers): hard limits, a hold for approval with an automatic refund if nobody approves, and a circuit breaker on volume (Klaus, 2026-11-24; ADR-0020). |
| R17 | **Sales tax as legally required**: collected via Stripe Tax wherever Klaus is registered, recorded per order and line; Stripe Tax's own report is what is filed (Klaus, 2026-11-24; ADR-0012). |
| R18 | **Mock Printful and mock Stripe**, usable instead of the real services by configuration, in CI and in test deployments, and verified against the real services by recording and comparing (Klaus, 2026-11-24; ADR-0024). |
| R19 | Test deployments **never confirm a Printful order and never move real money**: they use only Stripe test mode and drafts in the Printful test store (Klaus, 2026-11-24; reworded 2026-11-26 when mock mode moved to CI only, ADR-0029). |
| R20 | **No personal data to third parties that isn't needed**; where it would be needed for tracking or progress information, the customer's consent (Klaus, 2026-11-25; ADR-0031). |
| R21 | **Random order numbers**, five digits at the beginning (Klaus, 2026-11-25; ADR-0032). |
| R22 | **Smaller sizes at launch**, in landscape and portrait (Klaus, 2026-11-25; ADR-0033). |
| R23 | A **second gallery** can be added later (examples: christina-art, instagetter) without reworking orders or pages; not needed now (Klaus, 2026-11-25; ADR-0035). |

## 4. Quality requirements

| Id | Quality | Target |
|---|---|---|
| Q1 | No lost money | A payment that Stripe reports as succeeded always ends in a confirmed Printful order, a full refund, or both when Printful cancels a confirmed order (its charge returns to Klaus) or Klaus refunds anyway; a lost dispute is the bank's reversal. Never neither, never two confirmed Printful orders. |
| Q2 | No silent failure | Any order not progressing for longer than its expected time is detected within 1 hour and, if not auto-recoverable, reported to Klaus. |
| Q3 | Price integrity | The amount charged is computed by the server from configuration and Printful's quote; nothing price-related is taken from the browser. |
| Q4 | Privacy | Card data never reaches the shop. Personal data goes only where needed (R20) and is kept only as long as needed ([10 §4](10-security-privacy-legal.md#4-privacy)). |
| Q5 | Availability | One replica; brief downtime during deploys is acceptable. Webhooks missed during downtime are recovered by retries and polling. |
| Q6 | Performance | Public pages meet the cluster's Lighthouse floors (performance ≥ 90 on a phone). A quote returns in < 3 s: one Printful call (shipping rates); address and cost checks are local (ADR-0036). |
| Q7 | Accessibility | WCAG 2.2 AA, checked by axe in four browsers (cluster baseline). |
| Q8 | Durability | The order database survives the loss of the node (Litestream to S3, ADR-0014). |
| Q9 | Cost | No monthly fees beyond what exists (cluster, S3 cents). Per order: Stripe and Printful fees only. |

## 5. Traceability

| Req | Where |
|---|---|
| R1 | [03 §2](03-customer-journey.md#2-from-a-gallery-to-the-shop), ADR-0009 |
| R2 | [03 §3–4](03-customer-journey.md#3-picture-page), [07 §3](07-orders-data-jobs.md#3-schema), ADR-0026 |
| R3, R10 | [04 §2](04-catalog-and-print-files.md#2-skus-at-launch-adr-0033), ADR-0022 |
| R4 | [05 §2](05-quote-checkout-payment.md#2-quote) |
| R5 | [04 §7](04-catalog-and-print-files.md#7-previews-mockups) |
| R6 | [05 §3](05-quote-checkout-payment.md#3-checkout-session), ADR-0007, ADR-0023 |
| R7 | [06 §4](06-fulfilment.md#4-submission) |
| R8 | [06 §5](06-fulfilment.md#5-status-and-tracking), [09](09-notifications.md), ADR-0027 |
| R9 | [06 §7](06-fulfilment.md#7-failure-handling), [07 §5](07-orders-data-jobs.md#5-reconciliation), [08 §1](08-admin.md#1-principle) |
| R11 | [02 §4](02-architecture.md#4-runtime), [07](07-orders-data-jobs.md) |
| R12 | [08](08-admin.md), ADR-0013 |
| R13 | [06 §2](06-fulfilment.md#2-provider-interface), ADR-0017 |
| R14 | [11 §2.1](11-operations.md#21-mode-adr-0029), [12 §3–4](12-testing.md#3-against-the-real-services-before-go-live), ADR-0029 |
| R15 | [11](11-operations.md), ADR-0016 |
| R16 | [05 §3](05-quote-checkout-payment.md#3-checkout-session), [06 §8](06-fulfilment.md#8-fail-safes-against-large-or-unusual-orders), ADR-0020 |
| R17 | [05 §6](05-quote-checkout-payment.md#6-tax), ADR-0012 |
| R18 | [14](14-mock-services.md), [12](12-testing.md), ADR-0024 |
| R19 | [14 §9](14-mock-services.md#9-where-mock-mode-runs), [11 §2.1](11-operations.md#21-mode-adr-0029) |
| R20 | [10 §4](10-security-privacy-legal.md#4-privacy), [06 §3](06-fulfilment.md#3-printful-adapter), ADR-0031 |
| R21 | [07 §1](07-orders-data-jobs.md#1-identifiers), ADR-0032 |
| R22 | [04 §2](04-catalog-and-print-files.md#2-skus-at-launch-adr-0033), ADR-0033 |
| R23 | [04 §4](04-catalog-and-print-files.md#4-content-sources), [07 §3](07-orders-data-jobs.md#3-schema), ADR-0035 |

## 6. Out of scope (for launch)

- Selling the originals (art already does that at `/buy/<room>/<slug>`).
- Customer accounts, wishlists, reviews.
- Other currencies than USD; prices are USD.
- Discount codes (Stripe supports them with one flag; off until Klaus wants them).
- Limited or numbered editions.
- A second fulfilment provider (the interface exists; only Printful is implemented).
- A second gallery (R23: the design allows it; not built).
- Print sizes above 12 × 16 in (R22).

## 7. Assumptions

- A1. art's manifest is publicly readable and `uid` is stable (art's tests check permalinks by uid); a contract test and a daily check guard the format ([04 §4.3](04-catalog-and-print-files.md#43-the-art-adapter)).
- A2. art's 35 originals (25 works plus detail views; 3 paintings, 22 photographs) are iPhone JPEGs (Display P3) up to 4032 × 3024: all but one wide work reach ≥ 180 DPI at 12 × 16 (that one about 175, so its 12 × 16 offers are refused), and all reach ≥ 262 at 8 × 10 (measured 2026-11-24, corrected by review C F10; [04 §2](04-catalog-and-print-files.md#2-skus-at-launch-adr-0033)).
- A3. Klaus is the merchant of record; Printful bills his Printful account; Stripe pays out to his bank.
- A4. Shipping destinations start with the US only (ADR-0011); more countries are configuration plus tax registration.
- A5. Printful API v2 (beta) stays compatible enough; the adapter isolates changes (ADR-0005).
