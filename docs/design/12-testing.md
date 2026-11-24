# 12. Testing

## 1. Layers

| Layer | Tool | What |
|---|---|---|
| Unit | vitest | Money parsing, price and total computation, state machine edges, address validation, crop and DPI math, external-id generation, webhook signature verification (with Printful's documented scheme and Stripe's test helpers), retention rules. |
| Integration | vitest + supertest, real SQLite in a temp dir, **fakes** for Printful, Stripe, art and email, a controllable clock | The whole order lifecycle through HTTP: quote → checkout → webhook → submit → shipment → delivered; every failure row of [06 §7](06-fulfilment.md#7-failure-handling); every fail-safe of [06 §8](06-fulfilment.md#8-fail-safes-against-large-or-unusual-orders) (limits, hold reasons, breaker trip and reset, 72 h auto-refund with the fake clock); duplicate and out-of-order webhooks; crash between create and write (fake throws after Printful "created"); reconciliation recovering a lost webhook; refund paths; purge. Assertions only through what callers observe (HTTP, fake provider calls), not by reading tables (Pressline's rule). |
| Contract | vitest against **recorded fixtures** | The Printful adapter parses real v2 responses (shipping rates, order, shipment, webhook bodies, error bodies); the Stripe client handles real event payloads. Fixtures refreshed by `scripts/refresh-fixtures.ts` using the test-mode keys and a Printful draft (run by hand or weekly). |
| Print files | vitest + sharp | Rendering produces exact pixel sizes, sRGB, no EXIF; DPI refusal; Adobe RGB input converts; mug layout; content hash stable for the same render key; **peak memory** of rendering the largest SKU stays under 384 MiB (75% of the pod limit). |
| e2e (public) | Playwright, 4 browsers, axe, Lighthouse | Picture page, cart, address errors, quote, the redirect to a fake Checkout (a local stub of Stripe's redirect) and the return; order status page; 404s; no layout shift, no sideways scroll, compression. Cluster baseline (ADR-0016). |
| e2e (admin) | Playwright, Chromium | Sign-in is stubbed in test mode (a test-only login route enabled by `NODE_ENV=test`, absent from the production build); enable an offer, adjust a crop, refund an order. |
| Live check | Playwright @live + Lighthouse | After each deploy, read-only against `shop.klaushofrichter.net`. |

Coverage target: every state-machine edge and every failure row has at least one
integration test. The CI `test` job runs unit, integration, contract and print-file
tests; `e2e` runs the browser suites against the built image.

## 2. Fakes

- **Fake Printful**: an in-process HTTP server implementing the endpoints we use, with switches: slow cost calculation, 429 with `Retry-After`, 5xx, timeout, "create succeeded but response lost", permanent 400, order status progression, webhook emission (signed with a test secret).
- **Fake Stripe**: the official `stripe-mock` is not enough for Checkout flows; a small fake for Customers, Checkout Sessions, Refunds and event delivery (signed with a test secret via Stripe's `generateTestHeaderString`).
- **Fake art**: serves a manifest fixture and originals from `test/fixtures/` (synthetic images of known sizes and colour profiles).

## 3. Test mode against the real services

Before go-live, on the cluster with `STRIPE_MODE=test`, `FULFILMENT_CONFIRM=false`:

1. Real Printful catalog checks at startup pass for every SKU.
2. Real mockups generated for 2 pictures.
3. A full purchase with Stripe test card `4242 4242 4242 4242`: webhook arrives, Printful **draft** is created with the right items, files, recipient, shipping method; costs calculated; cost guard passes; the order stops as a draft.
4. Printful webhook registration verified by an event (e.g. `order_created` from the draft).
5. Declined card, 3-D Secure card, cancelled checkout, expired session.
6. Refund from the admin; refund from the Stripe Dashboard (picked up by `charge.refunded`).
7. Restore test of the database from S3.

## 4. Test mode and go-live

Go-live checklist (Klaus decides each box):

- [ ] All of §3 passed; results recorded in the release notes.
- [ ] Prices set; margins checked in the admin.
- [ ] Tax decision (ADR-0012) implemented; shipping countries (ADR-0011) set.
- [ ] Legal pages published; terms URL set in the Stripe Dashboard.
- [ ] Printful billing: card on file, wallet auto-recharge on; resale certificate if decided.
- [ ] Stripe live restricted key with the permissions of [05 §8](05-quote-checkout-payment.md#8-keys-and-modes); live webhook endpoint registered.
- [ ] **One real order per product kind** placed by Klaus (postcard, print, framed print, mug, t-shirt), paid with a real card, received and inspected; refund one of them through the admin to test the path. (Pressline's first live order found four bugs no test caught.)
- [ ] `STRIPE_MODE=live` and `FULFILMENT_CONFIRM=true` together, applied by Cluster.
- [ ] art's links switched on (pictures enabled).
