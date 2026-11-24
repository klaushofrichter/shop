# 14. Mock services

ADR-0024. Revised for review round 2 (2026-11-25): requests validated against the specs,
Stripe fidelity details, one clock, more scenarios, shadow mode dropped, recording
moved to the private repository and into the go-live orders, built step by step with
the shop (review 1 F23, review 2 F12).

## 1. Goals

| Id | Goal |
|---|---|
| M1 | Switching between real and mock is configuration only (`SHOP_MODE=mock`, base URLs, keys). No mock-specific code path in the shop. |
| M2 | Covers every endpoint and webhook the shop uses, with realistic state (asynchronous costs, file processing, order progression, shipments, holds). |
| M3 | Scriptable: every failure in [06 §7](06-fulfilment.md#7-failure-handling), every fail-safe in [06 §8](06-fulfilment.md#8-fail-safes-against-large-or-unusual-orders), every scenario in §6. |
| M4 | Runs in-process for tests, as a container in CI, and as a Deployment in a mock-mode test environment. |
| M5 | Verified: responses **and requests** conform to the published specs; behaviour is compared with recorded real interactions. |
| M6 | Safe: no path through the mocks or their verification can create a real payment or a real Printful order. |

## 2. Shape

```
             ┌──────────────── shop-mocks (one Node 26 process) ────────────────┐
 shop ──────►│ /printful/v2/…, /printful/orders/{id} (v1 cancel)   mock Printful │
 (adapters)  │ /stripe/v1/…                                         mock Stripe  │
 browser ───►│ /stripe/checkout/{session}   Pay / Decline / 3-D Secure / Cancel  │
 tests ─────►│ /__mock/…                    control API (not exposed publicly)   │
             │ webhook sender ───► shop /webhooks/printful, /webhooks/stripe      │
             │ state in memory (optional SQLite file), seeded ids, the shared Clock│
             └───────────────────────────────────────────────────────────────────┘
```

Directory `mocks/` with its own package and image `ghcr.io/klaushofrichter/shop-mocks`;
also a library, `createMocks({ webhookTarget, clock, publicUrl })`, for in-process tests.

## 3. Selecting mocks

`SHOP_MODE=mock` (ADR-0029) sets `PRINTFUL_BASE_URL` and `STRIPE_API_BASE` to the mock
and requires mock keys. Startup guards: a mock key only to a mock host, a real key only
to a real host; the mock rejects anything that isn't a mock key. **Mock keys don't look
like real keys** (short, oddly shaped, e.g. `mock-printful-1`, `mock-stripe-1`, fixed test
webhook secrets of the same style), so secret scanners don't trip and nobody mistakes
them (review 1 F23.10).

## 4. Mock Printful

Response shapes from the v2 OpenAPI spec and the captures; behaviour from the captures
where observed, from the spec where not.

- Catalog: products, variants, prices, availability, mockup styles for the configured SKUs (seeded from scrubbed captures).
- `POST /v2/shipping-rates`: a rate table by state and item class; the error shapes of the captures (missing state 400, invalid state 400, unknown variant 404, string id 400).
- Files: `POST /v2/files` → `waiting`, then `ok` (width, height, size, MIME type) or `failed` after a delay; de-duplicated by URL; `visible` honoured; `DELETE /v2/files/{id}` → 404 (as the real API).
- Orders: create (draft, costs `calculating` → `done`, or `failed` by scenario), get, `@external_id`, `PATCH` (costs back to `calculating`), confirm, v2 `DELETE` (drafts), v1 `DELETE` (→ `canceled`, stays visible), shipments; `external_id` unique forever (400 with the captured message); statuses including `inreview`; `store_id` in every webhook.
- Mockups: tasks `pending` → `completed` after ~20 s mock time; 2–10 per minute enforced.
- Webhooks: configuration with `secret_key`, `public_key`, `expires_at`; deliveries with `x-pf-webhook-signature` and `x-pf-webhook-public-key`, `occurred_at`, `retries`, `store_id`; retries at 1, 4, 16, 64, 256, 1024 minutes of mock time; shipment details only via `GET …/shipments` (the webhook body carries no carrier or estimate, as in the spec).
- Rate-limit headers as captured (`x-ratelimit-policy: 120;w=60;`, `remaining`, `reset`); 429 with `Retry-After`.
- **Everything after confirmation is spec-derived and unverified** until the go-live recording (§7.3); the code marks those behaviours as such.

## 5. Mock Stripe

- Form-encoded bodies with bracket keys; `expand[]`; Stripe's error envelope; **requests with any `Stripe-Version` other than the pinned one are rejected**; idempotency: a replay returns the first response, different parameters → 400 (captured message).
- Customers (create, get, delete); Checkout Sessions (create with the shop's parameters validated, get, expire); the session `url` is the mock's **public** checkout page address (a setting, so a phone can reach it in a mock-mode deployment; same origin for the CSP's `form-action`).
- **Checkout page**: shows items, shipping, tax, total and the `custom_text` ship-to line; buttons mirroring test cards: Pay, Decline, 3-D Secure fail, Cancel; accessible markup for Playwright.
- Payments: PaymentIntent with `latest_charge` (`outcome.risk_level` and `payment_method_details.card.fingerprint` settable, or absent as for some wallets).
- Tax: a table with one state that taxes shipping (Texas-like) and one that doesn't; `total_details.amount_tax`, `shipping_cost.amount_subtotal` vs `amount_total` as in the pinned version.
- Refunds (`charge_already_refunded`, `refund.failed` by scenario), disputes, early fraud warnings.
- Events and webhooks: `Stripe-Signature` (`t=…,v1=…`), payloads in the pinned version; one scenario sends a 2017-shaped payload.

## 6. Control API

`/__mock/*`, never routed publicly:

| Endpoint | Purpose |
|---|---|
| `POST /__mock/reset` | clear state, seed |
| `POST /__mock/clock/advance` | move the **shared clock** (shop and mock use one `Clock`; in a deployed mock environment a clock offset, refused outside mock mode) |
| `POST /__mock/scenario` | inject behaviour: status codes, 429 with `Retry-After`, timeouts, **confirm that succeeds but whose answer is lost**, **cancel whose answer is lost**, costs `failed`, `inreview`, holds, cancellation by Printful, returns, refund failure, dispute, early fraud warning |
| `POST /__mock/webhooks/{pause,resume,drop-next,duplicate-next,reorder}` | lost, duplicated and reordered deliveries |
| `POST /__mock/webhooks/send` | a delivery with a **bad signature** or a **stale timestamp** |
| `POST /__mock/stripe/sessions/{id}/pay` | **pay after cancel** or after the shop closed the checkout; two paid sessions for one cart |
| `POST /__mock/printful/orders/{id}/advance` | jump an order to a state, emitting webhooks |
| `GET /__mock/requests`, `GET /__mock/state` | assertions and the oracle for the invariant tests |

## 7. Verification against the real services

**7.1 Spec conformance, every CI run.** The mock validates every **request** it receives
against the pinned Printful v2 OpenAPI document and Stripe's OpenAPI spec of the pinned
version, and in tests **fails on unknown fields** (Printful tends to ignore a misspelled
field silently; the strict mock is the only place a typo in `orientation` would show).
Its own responses are validated too.

**7.2 Record and compare.** The recorder runs against the **test store** and Stripe
test mode only (never live), writes raw recordings to the **private repository**
(ADR-0028), and an **allow-list scrubber** (per endpoint: the fields kept verbatim;
everything else replaced by typed placeholders; ids rewritten consistently) produces the
synthetic fixtures committed here. Scenarios: catalog, shipping rates and errors, file
registration, mockup tasks, **draft create → get → patch → delete**, v1 cancel of a draft,
Stripe customers and sessions. The comparator replays the scenarios against the mock and
diffs status codes, headers, structure, types, enums and state changes. It runs by hand
or on a schedule on the cluster (no CI in the private repository). A drift report is a
file in the private repository; only scrubbed findings reach the public one.

**7.3 Recording at go-live.** The go-live test orders ([12 §4](12-testing.md#4-go-live-checklist-klaus-decides-each-box))
are recorded: every webhook body with its signature headers, every GET; one confirmed
order is cancelled on purpose. This closes the "after confirmation" gap.

**7.4 Real Stripe hosted page, weekly.** Playwright through Stripe's real test-mode page
with card 4242 and a real test-mode webhook ([12 §3](12-testing.md#3-against-the-real-services-before-go-live)).

Shadow mode is **dropped** (review 1 F23.2): it was a mock-specific path in the adapter
and put a real token into a mock deployment.

## 8. In CI

The mocks' tests (spec conformance, scenarios) run in the `test` job; the shop's
integration and invariant tests start the mocks in-process; `e2e` runs both images side
by side. No secrets.

## 9. Mock-mode deployment

`SHOP_MODE=mock` on the cluster: the shop and shop-mocks (ClusterIP), the mock's checkout
and tracking pages routed through the shop's ingress under `/__mock-pages/` behind the
preview gate, `/__mock` cluster-internal. **No real transaction can happen** (R19): the
shop's Secret holds only mock keys (`create-secrets.sh --mock`), and the startup guards
refuse real hosts with mock keys.

## 10. Build order

Each mock piece is built when the shop step that needs it starts (review 1 F23.11;
expect roughly the shop's own size again):
1. With step 3 (catalog, shipping rates): mock catalog, shipping rates, files, the clock, the control API skeleton, spec validation.
2. With step 6 (checkout): mock Stripe customers, sessions, checkout page, events and signatures.
3. With step 7 (submission): orders, webhooks, holds, shipments, all §6 scenarios; the invariant tests.
4. After the MVP (review 2 F12): the recorder, the allow-list scrubber and the comparator; then the go-live recording.
