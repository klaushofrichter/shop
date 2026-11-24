# 1. Requirements

## 1. Purpose

Let visitors of `art.klaushofrichter.net` buy reproductions of the paintings they see
there (postcards, prints, framed prints, mugs, t-shirts) in a shop at
`shop.klaushofrichter.net`, with payment, production, shipping and tracking fully
automated through Stripe and Printful.

## 2. Actors

| Actor | Role |
|---|---|
| Visitor / customer | Browses art, buys in the shop, follows the order. No account. |
| Klaus (owner, admin) | Chooses what is offered at what price, gets told about exceptions. Signs in to `/admin` with Google. |
| art (service) | The public gallery: manifest of paintings, public images, the originals on a private volume. |
| Stripe | Payment (hosted Checkout), optionally tax, refunds. |
| Printful | Production and shipping; bills Klaus's Printful account the wholesale cost per confirmed order. |
| Cluster session | Operates the k3s cluster: namespace, manifests, Secrets, backups. |

## 3. Minimum requirements

From Klaus, 2026-11-23 and 2026-11-24. Each has an id for tracing.

| Id | Requirement |
|---|---|
| R1 | The customer selects a picture on art and transitions to the shop with that picture as input. |
| R2 | In the shop the customer selects **one or more products for this picture** (with quantities) from a predefined set. |
| R3 | A **handful of predefined SKUs** is enough (e.g. a print of a given size, a t-shirt size M, postcards). Adding one later is a small change. |
| R4 | The customer provides a shipping address and gets **quoted the costs** (items + shipping, and tax if applicable) before paying. |
| R5 | **Previews** of the products with the picture, from Printful's mockup generator where possible. |
| R6 | Payment is **redirected to Stripe** (the shop never handles card data). |
| R7 | After payment the order goes to **Printful for fulfilment** automatically. |
| R8 | The shop receives **shipping confirmation and tracking** from Printful and stores it. Sending status and tracking emails to the customer is **optional for now**. |
| R9 | **Fully automated**: no routine work for Klaus per order. He is involved only for exceptions the system cannot resolve, and never as a step in the happy path. |
| R10 | **Repeatable and scalable** in the sense of: adding a picture or a SKU is configuration, not code; the process works the same for every order. |
| R11 | Volume: **fewer than 10 orders a week** from real customers (an estimate, not a limit). Simplicity beats throughput. |
| R12 | An admin area (Google sign-in, Klaus only) to choose which SKUs each picture offers and at what price. |
| R13 | A thin abstraction for fulfilment providers is acceptable (Printful now; another, e.g. Prodigi for fine-art prints, possible later). |
| R14 | Start in Stripe test mode and with Printful draft orders; go live only when Klaus says so. |
| R15 | Follow the cluster's repository and deployment rules (ADR-0016). |
| R16 | **Fail-safes against large or unusual orders** (misuse, not real customers): hard limits, a hold for approval with an automatic refund if nobody approves, and a circuit breaker on volume (Klaus, 2026-11-24; ADR-0020). |
| R17 | **Sales tax as legally required**: collected via Stripe Tax wherever Klaus is registered, recorded per order and line, exportable by period and state (Klaus, 2026-11-24; ADR-0012). |
| R18 | **Mock Printful and mock Stripe**, usable instead of the real services by configuration, in CI and in test deployments, and verified against the real services by recording and comparing (Klaus, 2026-11-24; ADR-0024). |
| R19 | Test deployments execute **no transaction with a real service and no Printful order** (Klaus, 2026-11-24). |

## 4. Quality requirements

| Id | Quality | Target |
|---|---|---|
| Q1 | No lost money | A payment that Stripe reports as succeeded always ends in exactly one of: a confirmed Printful order, or a full refund. Never neither, never two Printful orders. |
| Q2 | No silent failure | Any order not progressing for longer than its expected time is detected within 1 hour and, if not auto-recoverable, reported to Klaus. |
| Q3 | Price integrity | The amount charged is computed by the server from configuration and Printful's quote; nothing price-related is taken from the browser. |
| Q4 | Privacy | Card data never reaches the shop. Customer addresses are kept only as long as needed (see 10 §4). Originals of the paintings are never publicly reachable from the shop. |
| Q5 | Availability | One replica; brief downtime during deploys is acceptable. Webhooks missed during downtime are recovered by retries and polling. |
| Q6 | Performance | Public pages meet the cluster's Lighthouse floors (performance ≥ 90 on a phone). A quote returns in < 3 s (one Printful call). |
| Q7 | Accessibility | WCAG 2.2 AA, checked by axe in four browsers (cluster baseline). |
| Q8 | Durability | The order database survives the loss of the node (Litestream to S3, ADR-0014). |
| Q9 | Cost | No monthly fees beyond what exists (cluster, S3 cents). Per order: Stripe and Printful fees only. |

## 5. Traceability

| Req | Where |
|---|---|
| R1 | [03 §2](03-customer-journey.md#2-from-art-to-the-shop), ADR-0009 |
| R2 | [03 §3](03-customer-journey.md#3-picture-page), [07 §3](07-orders-data-jobs.md#3-schema), ADR-0008 |
| R3, R10 | [04 §2](04-catalog-and-print-files.md#2-skus), ADR-0022 |
| R4 | [05 §2](05-quote-checkout-payment.md#2-quote) |
| R5 | [04 §6](04-catalog-and-print-files.md#6-previews-mockups) |
| R6 | [05 §3](05-quote-checkout-payment.md#3-checkout-session), ADR-0007, ADR-0023 |
| R7 | [06 §4](06-fulfilment.md#4-submission) |
| R8 | [06 §5](06-fulfilment.md#5-status-and-tracking), [09](09-notifications.md) |
| R9 | [06 §7](06-fulfilment.md#7-failure-handling), [07 §5](07-orders-data-jobs.md#5-reconciliation), [08 §1](08-admin.md#1-principle) |
| R11 | [02 §4](02-architecture.md#4-runtime), [07](07-orders-data-jobs.md) |
| R12 | [08](08-admin.md), ADR-0013 |
| R13 | [06 §2](06-fulfilment.md#2-provider-interface), ADR-0017 |
| R14 | [11 §2](11-operations.md#2-configuration), [12 §4](12-testing.md#4-test-mode-and-go-live) |
| R15 | [11](11-operations.md), ADR-0016 |
| R16 | [05 §3](05-quote-checkout-payment.md#3-checkout-session), [06 §8](06-fulfilment.md#8-fail-safes-against-large-or-unusual-orders), ADR-0020 |
| R17 | [05 §6](05-quote-checkout-payment.md#6-tax), [08 §3](08-admin.md#3-pages), ADR-0012 |
| R18 | [14](14-mock-services.md), [12](12-testing.md), ADR-0024 |
| R19 | [14 §9](14-mock-services.md#9-test-deployment), [11 §1](11-operations.md#1-deployment) |

## 6. Out of scope (for launch)

- Selling the originals (art already does that at `/buy/<room>/<slug>`).
- Customer accounts, wishlists, reviews.
- **Orders mixing several pictures.** An order is for one picture (R2). A customer who wants two pictures places two orders. (Revisit if customers ask; the schema keeps the picture per item so it can be relaxed.)
- Other currencies than USD; prices are USD.
- Discount codes (Stripe supports them with one flag; off until Klaus wants them).
- Limited or numbered editions.
- A second fulfilment provider (the interface exists; only Printful is implemented).
- Customer-facing emails, if Klaus keeps them off (R8): the status page and Stripe's receipt cover the minimum.

## 7. Assumptions

- A1. art's manifest is publicly readable from its home page and `uid` is stable (art's tests check permalinks by uid).
- A2. Originals are iPhone JPEGs (Display P3), up to 4032 × 3024: enough for 8 × 10 at ≥ 289 DPI for every painting, and for 16 × 20 at 144–189 DPI (measured 2026-11-24; [04 §5.3](04-catalog-and-print-files.md#53-validation)).
- A3. Klaus is the merchant of record; Printful bills his Printful account; Stripe pays out to his bank.
- A4. Shipping destinations start with the US only (ADR-0011, proposed); the design supports more countries by configuration.
- A5. Printful API v2 (beta) stays compatible enough; the adapter isolates changes (ADR-0005).
