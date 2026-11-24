# 13. Delivery plan and open questions

## 1. Build order

Each step is one or more PRs to `main`, merged when green; nothing reaches customers
before step 9.

| Step | Content | Depends on |
|---|---|---|
| 1 | ~~Repo baseline, skeleton, CI~~ (done, PR #2) | — |
| 2 | Database, migrations, job runner, config loading and validation, SKU config, `/metrics` | design review |
| 3 | art manifest reader; Printful adapter (catalog, shipping rates) with contract fixtures; SKU check at startup | step 2, Printful token in CI? (no: fixtures) |
| 4 | Admin sign-in; pictures and offers pages; print-file rendering (from fixtures and uploaded masters); mockup jobs | step 3 |
| 5 | Public pages: picture page, cart, address, quote | step 4 |
| 6 | Checkout (Stripe Customer + Session), Stripe webhooks, success/cancel pages, order status page | step 5 |
| 7 | Submission, Printful webhooks, shipments, cost guard, failure handling, refunds, reconciliation, purge | step 6 |
| 8 | Alerts to Klaus; customer emails behind a flag (ADR-0015) | step 7 |
| 9 | Deploy to the cluster in **test mode** (Cluster: namespace, Secrets, PVC, Litestream, Ingress); art's internal endpoint and link (art's session); real test-mode run ([12 §3](12-testing.md#3-test-mode-against-the-real-services)) | steps 1–8, art, Cluster |
| 10 | Go-live checklist ([12 §4](12-testing.md#4-test-mode-and-go-live)), Klaus's go | Klaus |

Rough size: 3,000–4,000 lines of TypeScript including tests; steps 2–8 are a few
focused sessions each.

## 2. Decisions Klaus still makes

| ADR | Question | Recommendation | Needed by |
|---|---|---|---|
| 0010 | Failure windows: retry 24 h; refund automatically after 72 h on a billing hold and 24 h after a cost-guard stop | as proposed (fully automatic, R9) | step 7 |
| 0011 | Shipping countries | US only at launch | step 5 |
| 0012 | Sales tax | Stripe Tax on with home-state registration (ask an adviser); or off if he has no obligation | go-live |
| 0015 | Email provider (customer emails optional; alerts need a channel) | Amazon SES, or alerts via Grafana only at first | step 8 |
| 0020 | Hold large orders for approval | **Withdrawn as a recommendation**: it is manual work (R9). Rely on Stripe Radar; reconsider if fraud appears | — |
| 0023 | Address entered once, passed to Stripe as a Customer | yes | step 6 |
| — | Retail prices per SKU | Klaus | step 9 |
| — | Legal texts | Klaus (drafts on request) | go-live |
| — | S3 bucket + IAM user for backups | Klaus creates | step 9 |

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
10. **Is anything here over-engineered for < 10 orders a week?** Candidates: the provider interface, the jobs table, reconciliation every hour.

## 4. Items to verify before code depends on them

| Item | How |
|---|---|
| `shipping_options` without `shipping_address_collection` in hosted Checkout | Stripe test mode |
| Stripe Tax uses the Customer's shipping address | Stripe test mode |
| v1 cancel works with the store-level token | a Printful draft → confirm in a test store, or ask Printful support |
| Printful `orientation` / landscape posters | a draft order with a landscape file |
| Variant ids and print areas in `config/skus.json` | startup check against the live catalog (built in) |
| Printful emails to end customers for API stores (expected: none) | first test order |
| Cluster scraping and alerting from `/metrics` | Cluster |
