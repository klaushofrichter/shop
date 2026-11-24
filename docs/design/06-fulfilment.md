# 6. Fulfilment

Revised for review round 2 (2026-11-25): file registration in the interface, data
minimisation (ADR-0031), the invariants of [07 §2.8](07-orders-data-jobs.md#28-invariants)
in the submission algorithm, every v2 status and event, failures and fail-safes as
holds, threshold values out of the public documents. Round 2 fold-in (2026-11-26):
delete as the proof before a refund, attempt-aware events, start without Printful, no
confirm method in test mode.

## 1. Principles

- Providers only through an interface (ADR-0017); Printful is the only implementation.
- Webhooks are hints: verify, store, enqueue, answer 200, then re-fetch and act on the API's answer.
- Every create is idempotent by our ids; confirming costs Klaus money and happens only in `live` mode (and against the mock in `mock` mode), after the cost guard, for at most one provider order per paid order. In `test` mode the adapter is built **without** a confirm method (review A F9).
- Send the provider only what it needs to produce and ship (ADR-0031).

## 2. Provider interface

```ts
interface FulfilmentProvider {
  readonly id: 'printful';
  describeVariant(variantId: number): Promise<VariantSpec>;            // placement, technique, px, dpi, available, orientations
  shippingRates(to: Address, items: ItemRef[]): Promise<ShippingRate[]>;
  registerFile(url: string): Promise<{ providerFileId: string; status: FileStatus }>;  // review 2 F2
  getFileStatus(providerFileId: string): Promise<{ status: FileStatus; reason?: string }>;
  createMockup(req: MockupRequest): Promise<{ taskId: string }>;
  getMockup(taskId: string): Promise<MockupResult>;
  findOrder(externalId: string): Promise<ProviderOrder | null>;
  createDraft(order: DraftOrder): Promise<ProviderOrder>;
  getOrder(providerOrderId: string): Promise<ProviderOrder>;          // status, costs, shipments
  confirm?(providerOrderId: string): Promise<ProviderOrder>;          // absent in test mode
  deleteOrder(providerOrderId: string): Promise<'deleted' | 'refused'>; // v2 DELETE: the proof of "not charged" (I4)
  cancel(providerOrderId: string): Promise<'canceled' | 'not_cancellable'>;
  listRecentOrders(limit: number): Promise<ProviderOrderSummary[]>;  // reverse reconciliation
  verifyWebhook(rawBody: Buffer, headers: Headers): boolean;
  parseWebhook(rawBody: Buffer): ProviderEvent;                        // eventId, type, providerOrderId?, externalId?, occurredAt, storeId
}
type FileStatus = 'waiting' | 'ok' | 'failed';
```

Normalised order status: `draft | pending | inreview | on_hold | in_production |
partially_shipped | fulfilled | canceled | failed`. Costs status: `calculating | done |
failed` (review 1 F10). Errors: `NotCreated` (retry), `Unknown` (look up first),
`Permanent(reason)`, `RateLimited(retryAfter)`, `AlreadyExists` (duplicate `external_id`).

## 3. Printful adapter

- Base `https://api.printful.com`, `Authorization: Bearer <token of the mode's store>` (ADR-0029: the test store's token in test mode), 15 s timeout. Reads `X-Ratelimit-Remaining`/`-Reset` (v2: leaky bucket, `120;w=60`).
- At startup: `GET /v2/oauth-scopes` must include `orders`, `file_library`, `webhooks` (and read scopes); `GET /v2/stores` must return exactly the expected store for the mode. The expected store comes from its own variable per mode (`PRINTFUL_STORE_TEST`, `PRINTFUL_STORE_LIVE`, values in kube-setup), not from the token's section; a live start whose store equals the test store is refused.
- **Refuse to start only on a wrong answer** (wrong store, missing scope, key prefix against the mode) or a local configuration error. **No answer** (Printful unreachable) → start anyway with the provider marked *unverified*: Printful-calling jobs pause, the check retries every minute, an alert goes out if it lasts 30 min (review C F2). The catalog check uses the last good copy in `catalog.db`; a SKU is disabled by a mismatch, never by a timeout.
- **Recipient (ADR-0031)**: `name`, `address1`, `address2`, `city`, `state_code`, `zip`, `country_code`. **No `email`, no `phone`**: tracking and status reach the shop through Printful's webhooks and API, so Printful and the carriers don't need them. If a carrier ever requires a phone (e.g. a future express or international option), the checkout asks for it with an explicit consent line.
- **Order item**:

  ```json
  { "source": "catalog", "catalog_variant_id": 1350, "external_id": "<order_item id>",
    "quantity": 1, "retail_price": "59.00", "name": "Framed print 12 × 16 in — <title>",
    "orientation": "horizontal",
    "placements": [ { "placement": "default", "technique": "digital",
      "layers": [ { "type": "file", "url": "<PUBLIC_URL>/files/<sha256>.jpg" } ] } ] }
  ```

  Layers take a **URL** (the v2 layer schema has no file id). The file-library registration is a pre-flight check that Printful can fetch and read the file; the order still references the URL. `orientation` (`horizontal | vertical | any`) is set from the offer for products that allow both (framed posters; verified for unframed posters with one test-store draft, [13 §4](13-plan-and-open-questions.md#4-items-to-verify)).
  File URLs are built from the mode's `PUBLIC_URL`, so a test-store draft never points at the live host (review A F9); `/files/*` is outside the preview gate.
- **Order body**: `external_id = <order id>-<attempt>`, `shipping` (the method paid for, explicit), `recipient`, `order_items`, `retail_costs { currency, shipping, tax }`, `customization.packing_slip { store_name: <the shop's name>, email: <the shop's orders address>, custom_order_id: <order number> }`. The shop's own name on every slip (a cart may mix sources; review C F17) and the **shop's** contact address, so Printful doesn't print a default contact (review B F18; checked with one test-store draft). Never the customer's e-mail or phone.
- Lookup `GET /v2/orders/@<external_id>`. **Delete** via v2 `DELETE /v2/orders/{id}`: allowed for `draft`, `failed` and `canceled` orders that "have not been charged yet and … no payments pending" (spec), so a 204 is the proof I4 needs (reviews A F1/F8, B F8). **Cancel** a confirmed order via v1 `DELETE /orders/{id}` (captured on a draft: becomes `canceled`, stays visible; per the spec a cancel returns any charge to the store).
- Error mapping (captured): duplicate `external_id` → 400 "External ID validation error…" → `AlreadyExists` → look up; unknown variant → 404 → `Permanent`; address → 400 "Recipient: …" → `Permanent` with the message; `PATCH` resets costs to `calculating`.
- **Webhook verification**: `x-pf-webhook-signature` = hex HMAC-SHA256 of the raw body with the hex-decoded `secret_key`; `x-pf-webhook-public-key` must match `PRINTFUL_WEBHOOK_PUBLIC_KEY`; the body's `store_id` must be the mode's store; `occurred_at` within 24 h. Event id = SHA-256 of `type|occurred_at|order id|shipment id`, truncated to 32 hex (review 1 F10). The raw body and the signature headers are kept 30 days, so a recording can replay the check. The scheme is from the documentation only: one test-store draft's `order_created` verifies it ([13 §4](13-plan-and-open-questions.md#4-items-to-verify)).

## 4. Submission

Job `order.submit(order_id)`, enqueued by the payment transaction (no hold) or by
reconciliation ([07 §5](07-orders-data-jobs.md#5-reconciliation) step 2). Each step is
re-entrant.

1. **Preconditions** (I2), in one transaction: `payment_state ∈ {paid, partially_refunded}`, `failsafe_checked_at` set, no open hold, no shop-issued refund, `dispute_state ∈ {none, won}`. If they fail and no hold is open → an `attention` hold (`fulfilment_blocked`, alert), never a silent stop (I10).
2. **Claim** attempt N: insert `provider_orders(order_id, provider, attempt N, external_id, state = submitting)`; set `fulfilment_state = submitting`. N = 1, or N+1 only by the admin's "retry submission" after attempt N is proven cancelled or deleted, N ≤ 3 (I5).
3. **Look up** `@external_id`. Found → adopt (record id and status) and continue from its state.
4. **Create draft**. `Unknown` → next run starts at 3; `AlreadyExists` → 3; `NotCreated` → retry; `Permanent` → §7. Past the retry window (or still `Unknown`) → hold reason `provider_unavailable`, whose deadline refunds only if I4 holds.
5. **Wait for costs**: poll until `calculation_status` is `done` (~2–3 s captured), up to 60 s per run; `failed` → an `attention` hold.
6. **Cost guard**: `provider total (items + shipping + tax Printful charges Klaus) ≤ items + shipping paid − Stripe fee estimate − MARGIN_FLOOR_CENTS`. The customer's tax never counts as revenue. Fails → hold reason `cost_guard`, draft kept. Skipped only for an attempt with a recorded "confirm anyway" (`override_by`, `override_at`).
7. **Test mode stops here**: `fulfilment_state = test_draft_ok`, order complete ([07 §2.9](07-orders-data-jobs.md#29-test-mode)).
8. **Confirm** (`live`, and the mock in `mock` mode): read the charge's `amount_refunded` at Stripe (review A F13); then one transaction re-checks I2 and writes `confirm_requested_at`, `confirm_tries + 1`, `state = confirming`; then the call. Success → `confirmed`, `fulfilment_state = submitted`. No answer → stays `confirming`; after the **quiet period** (confirm timeout + 2 min) reconciliation reads the order: confirmed → `submitted`; `draft` → confirm the same order again (at most 3 tries, then an `attention` hold).

## 5. Status and tracking

`POST /webhooks/printful`: verify (§3) → `inbound_events` → enqueue → 200. Registered
once per store by `scripts/printful-webhook.ts` (`POST /v2/webhooks`, replaces the token's
config; `expires_at: null`; the returned `secret_key` and `public_key` go to the node's
`.env`; the System page shows the configuration and its expiry). The script takes the mode,
checks the token's store against the expected one, prints the current configuration and
asks before replacing it (review A F9).

Every event is resolved to an attempt by its `external_id` ([07 §2.4](07-orders-data-jobs.md#24-submission-attempts));
only the newest attempt moves `fulfilment_state`.

| Event | Effect (after re-fetching the order and its shipments) |
|---|---|
| `order_created`, `order_updated` | sync `fulfilment_state` |
| `order_failed` | `failed` → `attention` hold, alert at once (the reason is free text: shown, not parsed) |
| `order_canceled` | A cancel the shop issued: recorded, nothing else. Otherwise (Printful cancelled the newest attempt): `canceled` → `attention` hold whose deadline refunds if I4 holds (a cancel returns Printful's charge) |
| `order_put_hold`, `order_put_hold_approval` | `on_hold` → `provider` hold (`provider_hold`): alert at once and daily; never refunds by timer (ADR-0010 note) |
| `order_remove_hold` | hold `cleared`, back to the provider's state |
| `order_refunded` | Printful refunded Klaus (e.g. a defect): event + alert |
| `shipment_sent` | upsert `shipments` from `GET /v2/orders/{id}/shipments` (carrier, service, tracking number and URL, estimated delivery come from there, not from the webhook body); `partially_shipped`/`shipped`; enqueue the per-parcel e-mail |
| `shipment_delivered` | `delivered_at`; all delivered → `delivered`, order complete |
| `shipment_put_hold`, `shipment_put_hold_approval`, `shipment_remove_hold`, `shipment_out_of_stock`, `shipment_canceled`, `shipment_returned` | `shipment_status`/`delivery_status` updated; event + alert; the status page shows "returned to sender" or "delivery failed" for that parcel. A returned parcel needs Klaus: refund in the admin, or reship in Printful's dashboard and link it from the reverse sweep's alarm ([07 §2.4](07-orders-data-jobs.md#24-submission-attempts)) |
| `approval_sheet_status_changed` | event + alert (Printful asks for an approval) |

Not subscribed (review 1 F29): `catalog_stock_updated`, `catalog_price_changed`,
`mockup_task_finished`; the daily catalog refresh and polling cover them.

## 6. Cancellation

- Draft, `failed` or `canceled` and uncharged → v2 `DELETE` (gone; a refusal means it may have been charged → alert). Confirmed, not in production → v1 `DELETE` (`canceled`). In production or later → not cancellable: the admin offers "refund anyway" (Klaus's explicit choice; no hold follows).
- Every cancel is followed by a read; only `canceled`, a successful delete, or not found counts (I5).
- A **full** refund triggers a cancel attempt (I7); a partial refund doesn't.

## 7. Failure handling

Goal (Q1, R9): every paid order ends shipped or refunded without Klaus, except where only
he can act. Every exception is a **hold** with a deadline; a deadline refunds only when
I4 allows, otherwise it alerts.

| Failure | Detected by | Automatic handling | Klaus |
|---|---|---|---|
| Printful down, 5xx, timeout, 429 | submit job | Retry with backoff up to `PROVIDER_RETRY_WINDOW_HOURS`; look up before every create; then hold `provider_unavailable` (deadline refunds if I4) | alert after the window |
| `Permanent` at draft creation (address, variant, file), for any item | submit job | Draft deleted (if any), full refund of the whole cart, customer e-mail saying nothing ships | FYI |
| Costs `failed` | submit job | `attention` hold | decide, or the deadline deletes the draft and refunds (I4) |
| Cost guard fails | submit job | `attention` hold, draft kept | "confirm anyway" or let it refund |
| Confirm answer lost | submit job | stays `confirming`; quiet period, then read; confirm the same order again if still `draft` | — |
| Provider hold (any reason, billing included) | webhook, poll | `provider` hold; alert at once and daily | fix billing; never a timer refund (Printful would charge and ship once billing is fixed) |
| `order_failed` after confirmation | webhook, poll | `attention` hold; alert; the deadline tries v2 `DELETE`: success → refund, refused → alert | decide |
| Printful cancels | webhook | refund if I4 holds; customer e-mail | FYI |
| Refund made in the Stripe Dashboard | `charge.refunded` | full: I7, cancel if possible, else alert; partial: recorded only | — |
| Early fraud warning, dispute | Stripe webhook | `fraud` hold / cancel (§05 §4) | evidence for a dispute |
| Webhook lost, shop down | reconciliation | re-fetch and apply | — |
| Crash after create, before our write | lookup at step 3 | adopt | — |
| Returned parcel | webhook | event, alert, parcel line on the status page | refund, or reship in Printful and link it |
| Damaged or misprinted item | customer contact | — | report to Printful (photo, 30 days); reprint arrives as a new shipment |

## 8. Fail-safes against large or unusual orders

ADR-0020. Every layer is evaluated inside the payment transaction ([07 §2.1](07-orders-data-jobs.md#21-checkout-and-payment-payment_state)), so a restart can't skip it (review C F1). Normal orders pass untouched; unusual ones never reach Printful without Klaus,
and fail safe. **The threshold values are deployment configuration in kube-setup
(private), not in this public repository** (review 1 F27); the code requires them in live
mode and uses obviously artificial values in tests.

| Layer | Rule | Effect |
|---|---|---|
| Hard limits | per-SKU `maxQuantity` (config), items per order, order total | Checkout refused with the contact address. Checked when the cart changes, at the quote and at checkout. |
| Approval hold | **all** of these are evaluated and stored (review 1 F8): the order total at or above `APPROVAL_OVER_CENTS`; the same e-mail or card fingerprint has paid more than `REPEAT_OVER_CENTS` in total, or at least `REPEAT_ORDERS` orders, in the last 24 h (cumulative, review 1 F7); Radar risk `elevated` or `highest`; the circuit breaker is tripped | `approval` hold with all reasons. Admin **Approve** (recorded: who, when; the check is not re-run) or **Refund**. Deadline: refund (the order is never confirmed, so I4 holds). |
| Circuit breaker | more than `BREAKER_ORDERS_24H` paid orders, or more than `BREAKER_COST_CENTS_24H` provider cost, counted since `max(now − 24 h, breaker_reset_at)` | Breaker trips (stored in `settings`); alert; the order that crosses the limit and every later paid order get an `approval` hold with reason `breaker`. **Reset** sets `breaker_reset_at` and releases only holds whose sole reason is `breaker`; holds with other reasons stay for a decision. |
| Always | rate limits, Radar, the pre-payment cost check, the cost guard | as described |

Radar's risk level and the card fingerprint come from `expand: payment_intent.latest_charge`;
for some methods they are absent, which is **not** a hold reason.
