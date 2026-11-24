# 14. Mock services

ADR-0024. A service, **shop-mocks**, that impersonates Printful's and Stripe's APIs
closely enough that the shop can't tell the difference, in CI, on a developer machine
and in a test deployment; and a verification harness that keeps the mocks honest
against the real services.

## 1. Goals

| Id | Goal |
|---|---|
| M1 | Switching the shop between real and mock is configuration only: base URLs and keys. No mock-specific code paths in the shop. |
| M2 | Covers every endpoint and webhook the shop uses ([05](05-quote-checkout-payment.md), [06](06-fulfilment.md)), with realistic state: orders progress, costs calculate asynchronously, shipments appear with tracking. |
| M3 | Scriptable: tests and testers can force any failure in [06 §7](06-fulfilment.md#7-failure-handling) and any fail-safe in [06 §8](06-fulfilment.md#8-fail-safes-against-large-or-unusual-orders). |
| M4 | Runs in CI (a container, and in-process for unit/integration tests), on a laptop, and as a cluster Deployment. |
| M5 | **Verified** against the real services: responses conform to the published OpenAPI specs; recorded real interactions are compared with the mock's; read-only calls can be shadowed in real time. |
| M6 | **Safe**: no path through the mocks or the verification can create a real payment or a real Printful order. |

## 2. Shape

```
             ┌──────────────────────────── shop-mocks (one Node 26 process) ───────────────────────────┐
 shop ──────►│ /printful/v2/...  /printful/orders/{id} (v1 cancel)       mock Printful                  │
 (adapter)   │ /stripe/v1/...                                            mock Stripe                    │
             │ /stripe/checkout/{session}   ◄── tester's or Playwright's browser: Pay / Decline / 3DS…   │
             │ /__mock/...                  ◄── control API: scenarios, clock, advance orders, inspect  │
             │ webhook sender ──────────────────► shop /webhooks/printful, /webhooks/stripe (signed)    │
             │ state: in memory, optional SQLite file; deterministic ids with a seed                     │
             └───────────────────────────────────────────────────────────────────────────────────────────┘
```

- Node 26, Express, TypeScript, same conventions and CI as the shop (ADR-0016). Directory `mocks/` with its own package and image `ghcr.io/klaushofrichter/shop-mocks`.
- Also exported as a library: `createMocks({ webhookTarget, clock })` returns the Express app, so vitest integration tests run it in-process on a random port.

## 3. Selecting mocks in the shop

| Variable | Real | Mock |
|---|---|---|
| `PRINTFUL_BASE_URL` | `https://api.printful.com` | `http://shop-mocks:8090/printful` |
| `STRIPE_API_BASE` | `https://api.stripe.com` | `http://shop-mocks:8090/stripe` (stripe-node's `host`/`port`/`protocol` options) |
| `PRINTFUL_TOKEN` | the real token | `pf_mock_…` |
| `STRIPE_SECRET_KEY` | `rk_test_…` / `rk_live_…` | `rk_test_mock_…` |
| webhook secrets | from registration | fixed test values the mock signs with |

Guards (M6), enforced by the shop at startup:
- a key that is not a mock key may only be sent to the official hosts; a mock key only to a non-official host. So a real key can never leak to a mock, and a mock configuration can never reach a real API by mistake;
- `STRIPE_MODE=live` refuses mock URLs; the admin shows **MOCK** (in addition to TEST) when either provider is mocked.

The mock rejects any key without the `_mock_` marker, so a real key sent to it by mistake is refused, not accepted silently.

## 4. Mock Printful

Endpoints (the subset the shop uses, response shapes from the v2 OpenAPI spec):
- Catalog: `GET /v2/catalog-products/{id}`, `/catalog-variants/{id}`, `/catalog-products/{id}/mockup-styles`, `/catalog-variants/{id}/prices`, `/availability`. Data seeded from **recorded real responses** (§7), so variant ids, print areas and prices are real.
- `POST /v2/shipping-rates`: a rate table by country/state/weight class, seeded from recorded real quotes; same response shape including `shipments[]` and the optional delivery fields.
- Orders: `POST /v2/orders` (draft, `costs.calculation_status: calculating` then `done` after a configurable delay), `GET /v2/orders/{id}` and `@external_id`, `POST /v2/orders/{id}/confirmation`, `DELETE /v2/orders/{id}` (drafts only, as the real API), `GET /v2/orders/{id}/shipments`; v1 `DELETE /orders/{id}` (cancel). `external_id` uniqueness forever, as Printful.
- Mockups: `POST /v2/mockup-tasks`, `GET /v2/mockup-tasks` returning a generated preview (the print file composited onto a plain product silhouette), with the 2–10 per minute limit enforced.
- Files: `POST /v2/files`, `GET /v2/files/{id}` (fetches the URL like Printful does: `waiting` → `ok` with width, height, size, MIME type, or `failed`; de-duplicates by URL). `DELETE /v2/files/{id}` answers 404, as the real API does.
- Webhooks: `POST/GET/DELETE /v2/webhooks` returning `secret_key` (hex) and `public_key`; events delivered with `x-pf-webhook-signature` (HMAC-SHA256 of the body with the hex-decoded secret) and `x-pf-webhook-public-key`, retried at 1, 4, 16, 64, 256, 1024 minutes of **mock clock** time.
- Rate limiting: `X-Ratelimit-*` headers and `429` with `Retry-After`, configurable.

Order life cycle on the mock clock (defaults): confirmed → `inprocess` after 1 h → `shipment_sent` (carrier "USPS", a fake tracking number and a `tracking_url` to the mock's own tracking page) after 2 days → `shipment_delivered` after 5 days; each step emits its webhook. Multi-facility orders split into two shipments when they contain both apparel and paper products (as Printful does by departure facility).

## 5. Mock Stripe

- `POST /v1/customers`, `GET /v1/customers/{id}`.
- `POST /v1/checkout/sessions` (validates the parameters the shop sends against Stripe's spec; idempotency keys honoured), `GET /v1/checkout/sessions/{id}` with `expand[]=payment_intent`, `POST /v1/checkout/sessions/{id}/expire`.
- **Checkout page** `GET /stripe/checkout/{session}`: shows line items, shipping, tax and total as Stripe would compute them, and buttons that mirror Stripe's test cards: *Pay* (4242…), *Decline* (…0002), *3-D Secure fail*, *Delayed payment then succeed / fail*, *Cancel* (→ cancel_url). Accessible markup so Playwright drives it by role.
- Payment results: PaymentIntent and Charge objects with `outcome.risk_level` (settable: `normal`, `elevated`, `highest`) and `payment_method_details.card.fingerprint` (settable, to test the repeat-customer hold).
- Tax: when `automatic_tax.enabled`, a configurable rate table by state (default: a fixed rate for one "registered" state, zero elsewhere), mirroring Stripe Tax's fields (`total_details.amount_tax`).
- `POST /v1/refunds`; `charge.refunded`.
- Disputes: `POST /__mock/stripe/charges/{id}/dispute` creates `charge.dispute.created`.
- Events: `GET /v1/events/{id}`; webhook delivery with a correct `Stripe-Signature` (`t=…,v1=` HMAC-SHA256 of `t.payload` with the endpoint secret), the same event types and payload shapes as Stripe's API version pinned by the shop.

## 6. Control API (`/__mock`, never exposed publicly)

| Endpoint | Purpose |
|---|---|
| `POST /__mock/reset` | Clear state (between tests), optional seed. |
| `POST /__mock/clock/advance {duration}` | Move the mock clock; due order progressions and webhook retries fire. |
| `POST /__mock/scenario {provider, rule}` | Inject behaviour, e.g. `{"match":"POST /v2/orders","respond":"timeout_after_create","times":1}`, `"status":503`, `"status":429,"retryAfter":30`, `"permanent":"invalid_address"`, `costs_delay`, `hold:"billing"`, `cancel`, `return`. |
| `POST /__mock/printful/orders/{id}/advance {to}` | Jump an order to a state, emitting webhooks. |
| `POST /__mock/webhooks/pause`, `/resume`, `/drop-next` | Simulate lost or delayed webhooks. |
| `GET /__mock/requests` | Every request the mock received (for assertions: "exactly one order was created"). |
| `GET /__mock/state` | Orders, sessions, payments, refunds as the mock sees them. |

## 7. Verification against the real services

Four complementary checks. All of them touch real services only in the ways allowed
by M6.

**7.1 Schema conformance (every CI run).** The mock's own test suite validates every
response it produces against the published specs: Printful's v2 OpenAPI document
(`https://developers.printful.com/docs/v2-beta/openapi.json`, a pinned copy in
`mocks/specs/` refreshed by a script) and Stripe's OpenAPI spec (`stripe/openapi` on
GitHub, pinned to the API version the shop uses). A mock response that violates the
spec fails CI.

**7.2 Record and compare (scheduled, and on demand).**
- A **recorder** (`mocks/verify/record.ts`) runs a fixed list of scenarios against the real services and stores normalised request/response pairs as fixtures (`mocks/fixtures/real/<provider>/<scenario>.json`, with tokens, ids, timestamps, emails and addresses replaced by placeholders):
  - Printful, **read-only and order-free**: catalog products/variants/prices/availability/mockup-styles for every configured SKU; shipping rates for a set of addresses and carts; webhook configuration read; error responses (unknown variant, invalid address on shipping rates, missing auth). Mockup tasks optionally (no cost, rate-limited).
  - Stripe, **test mode only** (`rk_test_`; the recorder refuses any other key): create Customer; create Checkout Session with the shop's exact parameters; retrieve; expire; error cases (bad parameter, idempotency conflict). Completing a test payment needs Stripe's hosted page: optional, by Playwright with test card 4242 (still test mode, no money), which also records the real `checkout.session.completed` payload via a test webhook endpoint.
- The same scenarios run against the mock; a **comparator** diffs the normalised pairs: status codes, header presence (`X-Ratelimit-*`), JSON structure, types, enum values, field presence (required and optional), error shapes. Values that legitimately differ (ids, times, prices if the seed is old) are compared by type or tolerance. The result is a drift report.
- Run where the secrets live: on the cluster (in-cluster runner, weekly, using the test-mode Stripe key and the Printful token from the shop's Secret), not on GitHub-hosted runners. Drift opens a GitHub issue with the report; refreshed fixtures come back as a PR, so the mock and its seed data follow the real APIs.

**7.3 Shadow mode (real time, test deployment).** With `SHADOW_PRINTFUL=readonly`, the
shop's Printful adapter sends every read-only call (catalog, availability, shipping
rates) to both the mock and the real API, uses the real answer, and records a diff
(metric `shop_shadow_diffs_total{endpoint}` and a log line with the normalised
difference). Write calls (orders, confirmation, files, webhooks config) are never
shadowed. Same for Stripe in test mode with `SHADOW_STRIPE=test` for retrieve calls.

**7.4 Webhook signatures from the real services.** Recorded real webhook deliveries (a
Stripe test-mode event, a Printful event from the webhook test tool or a mockup task
finish) are replayed against the shop's verification code in CI, so the mock's signing
and the real signing are proven to verify identically.

**Gap, by Klaus's rule (no Printful orders):** order creation, confirmation, cancel and
shipment payloads can't be recorded from the real API. They are checked against the
OpenAPI spec (7.1) and Printful's documented examples. If Klaus later allows **draft**
orders (never charged or fulfilled, deleted right after), the recorder gains
create-draft → get → delete scenarios and closes most of this gap.

## 8. In CI

- `mocks` gets its own jobs in `production-checks.yml`: `mocks-test` (unit + schema conformance) as part of `test`, so required checks stay `test`, `codeql`, `e2e`.
- The shop's integration tests start the mocks in-process.
- The shop's `e2e` job runs the shop image and the mocks image side by side (`docker run --network host`), and Playwright completes purchases through the mock Checkout page: happy path, decline, cancel, held order + approval in the admin, refund.
- No secrets in GitHub Actions for any of this.

## 9. Test deployment

Namespace `shop` holds both Deployments while testing: `shop` configured with mock
URLs and mock keys, and `shop-mocks` (ClusterIP only). The mock Checkout page and the
mock tracking page are reached through the shop's ingress under `/__mock-pages/`
(an Ingress path routed to `shop-mocks`, present only in test deployments), so a
tester can buy from a phone. `/__mock` control endpoints are cluster-internal only.

**No real transaction can happen there**, by construction:
- the shop's Secret in the test deployment contains **no real Stripe key and no real Printful token** (`scripts/create-secrets.sh --mock`);
- the startup guards of §3 refuse real hosts with mock keys;
- `FULFILMENT_CONFIRM=false` in addition.
Shadow mode (7.3) is the only exception and is off by default; turning it on adds the
real Printful token for **read-only** calls, which create no orders.

## 10. Build order

Mocks come early, because every later step tests against them (updates [13 §1](13-plan-and-open-questions.md#1-build-order)):
1. Skeleton, control API, clock, request log; Printful catalog and shipping rates seeded from the existing probe data; schema conformance in CI.
2. Printful orders, webhooks with signing, life cycle; Stripe Customers, Sessions, Checkout page, events, refunds.
3. Recorder + comparator; first real recording (Printful read-only, Stripe test mode).
4. Shadow mode in the shop's adapter.
