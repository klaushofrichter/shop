# 12. Testing

Revised for review round 2 (2026-11-25): invariant tests, one clock, no test login
route, synthetic fixtures checked in CI. Round 2 fold-in (2026-11-26): mock mode only in
CI, test mode only before go-live (ADR-0029), go-live behind the preview gate, Printful-only
recording of the first real orders.

## 1. Layers

| Layer | Tool | What |
|---|---|---|
| Unit | vitest | Money parsing; totals; the three state machines and holds; address normalisation and the ZIP↔state table; crop, orientation and DPI math; order-number allocation; webhook signature verification (Stripe's test helper; Printful's documented scheme with a recorded delivery); retention rules; the cost guard never counts customer tax as revenue. |
| Integration | vitest + supertest, real SQLite in a temp dir, the mock services in-process ([14](14-mock-services.md)), fakes for the art source and SES, **one controllable clock** for shop and mocks | The whole order life cycle through HTTP; every row of [06 §7](06-fulfilment.md#7-failure-handling) and [06 §8](06-fulfilment.md#8-fail-safes-against-large-or-unusual-orders); every scenario of [14 §6](14-mock-services.md#6-control-api) (duplicate and reordered webhooks, pay after cancel, two sessions for one cart, confirm that times out after succeeding, lost cancel answer, refund failure, costs `failed`, `inreview`, dispute, early fraud warning, bad signature, stale timestamp); one e-mail per parcel; reverse reconciliation alarms. Assertions only through what callers observe. |
| **Invariant** | vitest, seeded random sequences | Random sequences of actions (pay, duplicate or reordered webhook, timeout, confirm answered late, cancel, full and partial refund in the Dashboard, refund failure, dispute, early fraud warning, provider cancel, clock advance, **restart between any two steps**) against the shop and the mocks, with the mock's state as the oracle. After every run, I1–I11 of [07 §2.8](07-orders-data-jobs.md#28-invariants) hold: at most one confirmed provider order per paid order; every paid, incomplete order has a job, a hold with a deadline, a refund in progress or a confirmed attempt; no provider order without `failsafe_checked_at`; no automatic refund of an order whose provider order was charged; "confirmed and fully refunded" only after an admin override **or a provider cancel**; the amount charged equals the quote. Failing seeds are kept as regression cases. |
| Contract | vitest against synthetic fixtures | The Printful and Stripe adapters parse fixtures written by hand from the spec and the private captures (until the scrubber exists, step 11), checked by the fixtures check (review B F15); a 2017-shaped Stripe event proves handlers use only `id`, `type`, `data.object.id`; the art adapter against a recorded copy of art's manifest. |
| Images | vitest + sharp | Exact pixel sizes, sRGB from Display P3, no metadata in **any** served image (print files, display images, mockups, uploads), `limitInputPixels` = `MAX_INPUT_MEGAPIXELS` (one value from the memory test, ~50 MP, for uploads and originals alike; a test at that size), DPI refusal, both orientations, mug layout, stable hashes; peak memory for the largest SKU below 384 MiB. |
| Fixtures check | a script in the `test` job | Fixtures are synthetic: e-mail only at `example.com`, addresses from a fixed list, no `client_secret`, no provider pay URLs, no ids or keys with real-looking prefixes; mock keys don't look like real ones; a secret scan over the repository. |
| e2e (public) | Playwright, 4 browsers, axe, Lighthouse, shop image + mocks image | Picture pages, cart with two pictures, address errors, quote, purchase through the mock Checkout page (pay, decline, cancel and pay later), status page with two parcels, find my order twice, preview gate and banner in mock mode, `/files/*`, `/img/*`, `/mockups/*` served without the preview cookie, 404s; layout shift, sideways scroll, compression. |
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

Mock mode runs **only in CI** (the shop image and the mocks image side by side). On the
cluster the shop starts in **test** mode: the Printful **test store**, Stripe test mode,
nothing confirmed (the adapter has no confirm method), preview gate on. Klaus agreed on
2026-11-26 that the first cluster deployment talks to these real test services (R19).

1. Startup checks pass: SKU variants, print areas, the test store's scopes and identity.
2. File registration and mockups for two works, both orientations; landscape verified on an unframed poster draft.
3. A purchase with test card 4242 through Stripe's real hosted page: the webhook arrives, a **draft in the test store** is created with the right items, files, recipient (no e-mail, no phone), packing slip and shipping method; costs calculate; the cost guard passes; the order shows "Test order"; the draft stays in the test store for inspection (deleted after 7 days); the payment is not refunded automatically.
4. Declined card, 3-D Secure, cancel and return, expired session; then, on the orders of item 3, a refund from the admin and a full and a partial refund from the Stripe Dashboard.
5. Stripe Tax with a test-mode registration in a state that taxes shipping (Texas) and one that doesn't: amounts and the shipping check of [05 §4](05-quote-checkout-payment.md#4-payment-webhooks).
6. E-mails to the allow-list; a bounce notice reaches Klaus's mailbox ([09](09-notifications.md)).
7. Restore of both database files from S3.
8. `/health/worker` turns 503 when the runner is stopped, and the uptime monitor reports it.

Items 3, 4 and 6 run as `e2e/test-mode.spec.ts` (Playwright through Stripe's real hosted
page, 14 §7.4), started by Cluster on the node with the preview key from the `.env` and the SES
mailbox simulator addresses as customers; refunds from the admin and the Stripe Dashboard, Stripe
Tax and the bounce notices in the mailbox are Klaus's checks by hand.

Shipments, per-parcel pages and shipped e-mails are never seen in test mode (nothing is
produced); CI covers them against the mock. Test mode exists only until go-live (ADR-0029):
afterwards a real-service check is the capture script run by hand against the test store
and Stripe test mode ([14 §7](14-mock-services.md#7-verification-against-the-real-services)).

## 4. Go-live checklist (Klaus decides each box)

- [ ] §3 passed; results in the release notes.
- [ ] Prices set; margins checked in the admin; the fail-safe thresholds set in kube-setup (deliberately different from the proposals published in ADR-0020).
- [ ] Stripe Tax registration in the home state; resale certificate at Printful.
- [ ] Legal pages; terms URL in the Stripe Dashboard; SES production access, SPF and DKIM; bounce and complaint notices forwarded to the shop's mailbox.
- [ ] Printful live store billing: card on file, a modest wallet auto-recharge.
- [ ] Live Stripe key with the permissions of [05 §8](05-quote-checkout-payment.md#8-keys-and-modes); live webhook endpoint created (latest version); live Printful webhook registered; the Stripe test-mode endpoint and the test store's webhook disabled.
- [ ] `SHOP_MODE=live` **with the preview gate on** (`PREVIEW_GATE=on`, `/api/offers` empty), applied by Cluster (review C F5).
- [ ] **One real order per product kind** through the gate, paid with a real card, received and inspected; one refunded through the admin. During these orders only **Printful** is recorded: the stored `inbound_events` (raw body and signature headers) and the adapter's request trace are exported to the private repository; nothing from live Stripe (ADR-0028 note). One confirmed order is cancelled on purpose to record the v1 cancel of a confirmed order (Klaus's choice: per the spec a cancel returns Printful's charge).
- [ ] Preview gate off; works enabled; art's links appear; `PREVIEW_GATE: 'off'` in `live-check.yml`, so the live check tests the pages again.
