# 13. Delivery plan and open questions

## 1. Build order

Each step is one or more PRs to `main`, merged when green; nothing reaches customers
before step 9.

| Step | Content | Depends on |
|---|---|---|
| 1 | ~~Repo baseline, skeleton, CI~~ (done, PR #2) | — |
| 2 | Database, migrations, job runner, config loading and validation, SKU config, `/metrics` | design review |
| 2a | **Mock services**, stages 1–2 ([14 §10](14-mock-services.md#10-build-order)): Printful catalog, shipping rates, orders, webhooks; Stripe Customers, Sessions, Checkout page, events, refunds; control API; schema conformance in CI | design review |
| 3 | art manifest reader; Printful adapter (catalog, shipping rates) tested against the mocks; SKU check at startup | steps 2, 2a |
| 4 | Admin sign-in; pictures and offers pages; print-file rendering (from fixtures and uploaded masters); mockup jobs | step 3 |
| 5 | Public pages: picture page, cart, address, quote | step 4 |
| 6 | Checkout (Stripe Customer + Session), Stripe webhooks, success/cancel pages, order status page | step 5 |
| 7 | Submission, Printful webhooks, shipments, cost guard, failure handling, refunds, reconciliation, purge | step 6 |
| 8 | Alerts to Klaus and customer emails via Amazon SES (customer emails behind a flag); mock verification stages 3–4 (recorder, comparator, shadow mode) | step 7 |
| 9 | `scripts/create-secrets.sh`; deploy to the cluster in **mock mode** (shop + shop-mocks, no real keys in the pod, [14 §9](14-mock-services.md#9-test-deployment)), then **test mode** (Cluster: namespaces, Secrets, PVC, Litestream, Ingress, NetworkPolicy, `production` branch); art's internal endpoint with its own tests, the Traefik block, and the link (art's session, Cluster); real test-mode run ([12 §3](12-testing.md#3-test-mode-against-the-real-services)) | steps 1–8, art, Cluster |
| 10 | Go-live checklist ([12 §4](12-testing.md#4-test-mode-and-go-live)), Klaus's go | Klaus |

Rough size: 3,000–4,000 lines of TypeScript including tests; steps 2–8 are a few
focused sessions each.

## 2. Decisions

Decided by Klaus on 2026-11-24: ADR-0010 (failure windows as proposed), 0011 (US only),
0012 (sales tax as legally required, via Stripe Tax), 0015 (Amazon SES), 0020
(fail-safes), 0023 (address via Stripe Customer), 0024 (mock services). No ADR is
Proposed at the moment.

Still Klaus's, outside the ADRs:

| Item | Needed by |
|---|---|
| Retail prices per SKU (defaults in config are placeholders) | step 10 |
| Fail-safe thresholds (defaults in ADR-0020) | step 7 |
| Home-state seller's permit; registration in Stripe Tax; resale certificate at Printful ([research](../research/sales-tax.md) §5) | go-live |
| SES: domain verification records at Squarespace, production access | step 8 |
| S3 bucket + IAM user for backups | step 9 |
| Stripe restricted keys with Customers write; Printful billing with auto-recharge | step 9 |
| Legal texts (drafts on request) | go-live |

## 3. Open questions for the review

1. **Build vs. buy.** Shopify Starter + Printful + Buy Button costs $5/month and no code but needs 15–30 min of setup per painting and loses the deep link and own look ([research](../research/process-alternatives.md)). Is the custom build worth it?
2. **One picture per order.** Matches Klaus's flow (R2) and keeps the UI simple. Is it too restrictive for someone who wants two postcards of different paintings?
3. **Shipping in Checkout without address collection** (`shipping_options` with only a Customer address): if Stripe requires `shipping_address_collection` for `shipping_options`, the fallback is shipping as a line item. Any better option?
4. **Print files at public, unguessable URLs** vs. Printful's file library: equivalent exposure, since the library needs a URL too. Is a full-resolution reproduction at an unguessable URL acceptable?
5. **Cost guard threshold**: refuse to confirm if Printful's cost exceeds what the customer paid minus Stripe's fee. Too strict (shipping quotes drift by cents)? Proposed tolerance: allow up to 50¢ over.
6. **art's link only for enabled pictures** (via `/api/offers`) vs. always showing it.
7. **Alerts channel** before an email provider exists: Grafana alert on `/metrics`, or require SES from the start?
8. **Mug layout**: the painting twice, left and right of the handle. Better: one wide panorama crop? (Taste.)
9. **Orientation of prints**: does Printful's `orientation` field on the order item select landscape for posters, or is a landscape file enough? (To verify with a draft order.)
10. **Fail-safe thresholds** (ADR-0020): do they stop misuse without bothering real customers? Is auto-refund after 72 h the right fail-safe default?
11. **Is anything here over-engineered for < 10 orders a week?** Candidates: the provider interface, the jobs table, reconciliation every hour.

## 4. Items to verify before code depends on them

| Item | How |
|---|---|
| `shipping_options` without `shipping_address_collection` in hosted Checkout | Stripe test mode |
| Stripe Tax uses the Customer's shipping address | Stripe test mode (test-mode tax registration) |
| Clothing tax code (`txcd_30011000`?) | `GET /v1/tax_codes` |
| v1 cancel works with the store-level token | a Printful draft → confirm in a test store, or ask Printful support |
| Printful `orientation` / landscape posters | a draft order with a landscape file |
| Variant ids and print areas in `config/skus.json` | startup check against the live catalog (built in) |
| Printful emails to end customers for API stores (expected: none) | first test order |
| Cluster scraping and alerting from `/metrics` | Cluster |
