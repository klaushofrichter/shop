# 12. Testing

Revised for review round 2 (2026-11-25): invariant tests, one clock, no test login
route, synthetic fixtures checked in CI, recording during the go-live test orders, a
scheduled real Stripe test-mode run.

## 1. Layers

| Layer | Tool | What |
|---|---|---|
| Unit | vitest | Money parsing; totals; the three state machines and holds; address normalisation and the ZIP↔state table; crop, orientation and DPI math; order-number allocation; webhook signature verification (Stripe's test helper; Printful's documented scheme with a recorded delivery); retention rules; the cost guard never counts customer tax as revenue. |
| Integration | vitest + supertest, real SQLite in a temp dir, the mock services in-process ([14](14-mock-services.md)), fakes for the art source and SES, **one controllable clock** for shop and mocks | The whole order life cycle through HTTP; every row of [06 §7](06-fulfilment.md#7-failure-handling) and [06 §8](06-fulfilment.md#8-fail-safes-against-large-or-unusual-orders); every scenario of [14 §6](14-mock-services.md#6-control-api) (duplicate and reordered webhooks, pay after cancel, two sessions for one cart, confirm that times out after succeeding, lost cancel answer, refund failure, costs `failed`, `inreview`, dispute, early fraud warning, bad signature, stale timestamp); one e-mail per parcel; reverse reconciliation alarms. Assertions only through what callers observe. |
| **Invariant** | vitest, seeded random sequences | Random sequences of actions (pay, duplicate or reordered webhook, timeout, cancel, refund in the Dashboard, dispute, early fraud warning, clock advance, restart) against the shop and the mocks, with the mock's state as the oracle. After every run, I1–I9 of [07 §2.6](07-orders-data-jobs.md#26-invariants) hold: every paid session has at most one confirmed provider order, or a full refund, or an open hold with a deadline; never confirmed and fully refunded without an admin override; the amount charged equals the quote. Failing seeds are kept as regression cases. |
| Contract | vitest against synthetic fixtures | The Printful and Stripe adapters parse responses derived from the real captures (scrubbed, ADR-0028); a 2017-shaped Stripe event proves handlers use only `id`, `type`, `data.object.id`; the art adapter against a recorded copy of art's manifest. |
| Images | vitest + sharp | Exact pixel sizes, sRGB from Display P3, no metadata in **any** served image (print files, display images, mockups, uploads), `limitInputPixels`, DPI refusal, both orientations, mug layout, stable hashes; peak memory for the largest SKU below 384 MiB. |
| Fixtures check | a script in the `test` job | Fixtures are synthetic: e-mail only at `example.com`, addresses from a fixed list, no `client_secret`, no provider pay URLs, no ids or keys with real-looking prefixes; mock keys don't look like real ones; a secret scan over the repository. |
| e2e (public) | Playwright, 4 browsers, axe, Lighthouse, shop image + mocks image | Picture pages, cart with two pictures, address errors, quote, purchase through the mock Checkout page (pay, decline, cancel and pay later), status page with two parcels, find my order, preview gate and banner in mock mode, 404s; layout shift, sideways scroll, compression. |
| e2e (admin) | Playwright, Chromium | The test **mints a real signed `shop_admin` cookie** with the e2e job's `COOKIE_SECRET` and an `ALLOWED_EMAILS` of `e2e@example.com` (review 2 F8): no test login route exists in the application. Enable a work and offers, choose an anchor, approve a held order, refund. |
| Live check | Playwright @live + Lighthouse | After each deploy, read-only, never opens an order or admin page. |

The CI `test` job runs unit, integration, invariant, contract, image and fixtures
checks; `e2e` runs the browser suites against the built shop image and the mocks image.
No secrets in GitHub Actions.

## 2. Mocks and fakes

- **Printful and Stripe**: shop-mocks ([14](14-mock-services.md)).
- **Content source**: a fake art serving a manifest fixture and synthetic originals of known sizes and colour profiles (Display P3, none, landscape, portrait).
- **SES**: a fake recording messages.

## 3. Against the real services before go-live

On the cluster, first in **mock** mode (no real keys), then in **test** mode (the
Printful **test store**, Stripe test mode, nothing confirmed, preview gate on):

1. Startup checks pass: SKU variants, print areas, the test store's scopes and identity.
2. File registration and mockups for two works, both orientations; landscape verified on an unframed poster draft.
3. A purchase with test card 4242 through Stripe's real hosted page: the webhook (from the test-mode endpoint with the pinned version) arrives, a **draft in the test store** is created with the right items, files, recipient (no e-mail, no phone) and shipping method; costs calculate; the cost guard passes; the draft stays a draft.
4. Declined card, 3-D Secure, cancel and return, expired session, refund from the admin, refund from the Stripe Dashboard.
5. Stripe Tax with a test-mode registration in a state that taxes shipping (Texas) and one that doesn't: amounts and the shipping check of [05 §4](05-quote-checkout-payment.md#4-payment-webhooks).
6. E-mails to the allow-list; a bounce.
7. Restore of the database from S3.

A **scheduled weekly run** of item 3 in Stripe test mode keeps the one check that only the
real hosted page can give (review 1 F23.6).

## 4. Go-live checklist (Klaus decides each box)

- [ ] §3 passed; results in the release notes.
- [ ] Prices set; margins checked in the admin; the fail-safe thresholds set in kube-setup.
- [ ] Stripe Tax registration in the home state; resale certificate at Printful.
- [ ] Legal pages; terms URL in the Stripe Dashboard; SES production access, SPF and DKIM.
- [ ] Printful live store billing: card on file, a modest wallet auto-recharge.
- [ ] Live Stripe key with the permissions of [05 §8](05-quote-checkout-payment.md#8-keys-and-modes); live webhook endpoint created with the pinned version; live Printful webhook registered.
- [ ] **One real order per product kind**, paid with a real card, received and inspected; one refunded through the admin. **The recorder runs during these orders** (review 1 F23.3): every webhook body with its signature headers and every GET is captured to the private repository, scrubbed fixtures follow, and one confirmed order is cancelled on purpose to record the v1 cancel of a confirmed order.
- [ ] `SHOP_MODE=live`, applied by Cluster.
- [ ] Works enabled; art's links appear.
