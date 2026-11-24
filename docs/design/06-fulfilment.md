# 6. Fulfilment

Revised for review round 2 (2026-11-25): file registration in the interface, data
minimisation (ADR-0031), the invariants of [07 §2.6](07-orders-data-jobs.md#26-invariants)
in the submission algorithm, every v2 status and event, failures and fail-safes as
holds, threshold values out of the public documents.

## 1. Principles

- Providers only through an interface (ADR-0017); Printful is the only implementation.
- Webhooks are hints: verify, store, enqueue, answer 200, then re-fetch and act on the API's answer.
- Every create is idempotent by our ids; confirming costs Klaus money and happens at most once per attempt, only in live mode (or in test mode against the **test store**, never confirmed), after the cost guard.
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
  confirm(providerOrderId: string): Promise<ProviderOrder>;
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
- At startup: `GET /v2/oauth-scopes` must include `orders`, `file_library`, `webhooks` (and read scopes); `GET /v2/stores` must return exactly the expected store for the mode; otherwise the process refuses to start.
- **Recipient (ADR-0031)**: `name`, `address1`, `address2`, `city`, `state_code`, `zip`, `country_code`. **No `email`, no `phone`**: tracking and status reach the shop through Printful's webhooks and API, so Printful and the carriers don't need them. If a carrier ever requires a phone (e.g. a future express or international option), the checkout asks for it with an explicit consent line.
- **Order item**:

  ```json
  { "source": "catalog", "catalog_variant_id": 1350, "external_id": "<order_item id>",
    "quantity": 1, "retail_price": "59.00", "name": "Framed print 12 × 16 in — <title>",
    "orientation": "horizontal",
    "placements": [ { "placement": "default", "technique": "digital",
      "layers": [ { "type": "file", "url": "https://shop.klaushofrichter.net/files/<sha256>.jpg" } ] } ] }
  ```

  Layers take a **URL** (the v2 layer schema has no file id). The file-library registration is a pre-flight check that Printful can fetch and read the file; the order still references the URL. `orientation` (`horizontal | vertical | any`) is set from the offer for products that allow both (framed posters; verified for unframed posters with one test-store draft, [13 §4](13-plan-and-open-questions.md#4-items-to-verify)).
- **Order body**: `external_id = <order id>-<attempt>`, `shipping` (the method paid for, explicit), `recipient`, `order_items`, `retail_costs { currency, shipping, tax }`, `customization.packing_slip { store_name, custom_order_id: <order number> }` with the store name from the source configuration ([04 §4](04-catalog-and-print-files.md#4-content-sources)), never an e-mail or phone.
- Lookup `GET /v2/orders/@<external_id>`; cancel via **v1** `DELETE /orders/{id}` (captured on a draft: becomes `canceled`, stays visible).
- Error mapping (captured): duplicate `external_id` → 400 "External ID validation error…" → `AlreadyExists` → look up; unknown variant → 404 → `Permanent`; address → 400 "Recipient: …" → `Permanent` with the message; `PATCH` resets costs to `calculating`.
- **Webhook verification**: `x-pf-webhook-signature` = hex HMAC-SHA256 of the raw body with the hex-decoded `secret_key`; `x-pf-webhook-public-key` must match the configured one; the body's `store_id` must be the mode's store; `occurred_at` within 24 h. Event id = SHA-256 of `type|occurred_at|order id|shipment id`, truncated to 32 hex (review 1 F10).

## 4. Submission

Job `order.submit(order_id)`, enqueued when payment is `paid` and the fail-safe check
passed (I2). Each step is re-entrant.

1. **Preconditions** (I2), in one transaction: `payment_state = paid`, no open hold, `refund_requested_at` null, `dispute_state = none`. Otherwise stop.
2. **Claim** attempt N: insert `provider_orders(order_id, provider, attempt N, external_id, state = submitting)`; set `fulfilment_state = submitting`. N = 1, or N+1 only if attempt N is proven `canceled`/`gone` (I5).
3. **Look up** `@external_id`. Found → adopt (record id and status) and continue from its state.
4. **Create draft**. `Unknown` → next run starts at 3; `AlreadyExists` → 3; `NotCreated` → retry; `Permanent` → §7.
5. **Wait for costs**: poll until `calculation_status` is `done` (~2–3 s captured), up to 60 s per run; `failed` → an `attention` hold (alert, no refund until I4 holds).
6. **Cost guard**: `provider total (items + shipping + tax Printful charges Klaus) ≤ items + shipping paid − Stripe fee estimate − MARGIN_FLOOR_CENTS`. The customer's tax never counts as revenue. Fails → `attention` hold.
7. **Confirm**, only in live mode: in one transaction check I3 (no refund requested, no open hold) and write `confirm_requested_at`, `state = confirming`; then call confirm. Success → `confirmed`, `fulfilment_state = submitted`. `Unknown` → stays `confirming`; the next run reads the order (§5) before anything else. In test mode the draft in the test store is **never confirmed**; the job records `test: stopped at draft` as an event and the nightly purge deletes test drafts after 7 days.

## 5. Status and tracking

`POST /webhooks/printful`: verify (§3) → `inbound_events` → enqueue → 200. Registered
once per store by `scripts/printful-webhook.ts` (`POST /v2/webhooks`, replaces the token's
config; `expires_at: null`; the returned `secret_key` and `public_key` go to the node's
`.env`; the System page shows the configuration and its expiry).

| Event | Effect (after re-fetching the order and its shipments) |
|---|---|
| `order_created`, `order_updated` | sync `fulfilment_state` |
| `order_failed` | `failed` → `attention` hold, alert at once (the reason is free text: shown, not parsed) |
| `order_canceled` | `canceled` → `attention` hold with action refund (I4) |
| `order_put_hold`, `order_put_hold_approval` | `on_hold` → `provider` hold, alert at once, deadline from config |
| `order_remove_hold` | hold `cleared`, back to the provider's state |
| `order_refunded` | Printful refunded Klaus (e.g. a defect): event + alert |
| `shipment_sent` | upsert `shipments` from `GET /v2/orders/{id}/shipments` (carrier, service, tracking number and URL, estimated delivery come from there, not from the webhook body); `partially_shipped`/`shipped`; enqueue the per-parcel e-mail |
| `shipment_delivered` | `delivered_at`; all delivered → `delivered` |
| `shipment_put_hold`, `shipment_put_hold_approval`, `shipment_remove_hold`, `shipment_out_of_stock`, `shipment_canceled`, `shipment_returned` | event + alert; a returned parcel needs Klaus (reship or refund) |
| `approval_sheet_status_changed` | event + alert (Printful asks for an approval) |

Not subscribed (review 1 F29): `catalog_stock_updated`, `catalog_price_changed`,
`mockup_task_finished`; the daily catalog refresh and polling cover them.

## 6. Cancellation

- Draft → v2 `DELETE` (gone). Confirmed, not in production → v1 `DELETE` (`canceled`). In production or later → not cancellable: the admin offers "refund anyway" (Klaus's explicit choice).
- Every cancel is followed by a read; only a read showing `canceled` or not found counts (I5).
- A refund from anywhere triggers a cancel attempt (I7).

## 7. Failure handling

Goal (Q1, R9): every paid order ends shipped or refunded without Klaus, except where only
he can act. Every exception is a **hold** with a deadline; a deadline refunds only when
I4 allows, otherwise it alerts.

| Failure | Detected by | Automatic handling | Klaus |
|---|---|---|---|
| Printful down, 5xx, timeout, 429 | submit job | Retry with backoff up to the retry window; look up before every create | alert after the window |
| `Permanent` at draft creation (address, variant, file) | submit job | Draft deleted (if any), full refund, customer e-mail | FYI |
| Costs `failed` | submit job | `attention` hold | decide, or the deadline refunds (I4: draft only) |
| Cost guard fails | submit job | `attention` hold, draft kept | "confirm anyway" or let it refund |
| Confirm answer lost | submit job | stays `confirming`; read before anything else | — |
| Provider hold (any reason, billing included) | webhook, poll | `provider` hold; alert at once | fix billing; deadline: alert (a confirmed order can't be auto-refunded unless I4) |
| `order_failed` after confirmation | webhook, poll | `attention` hold; alert | decide |
| Printful cancels | webhook | refund if I4 holds; customer e-mail | FYI |
| Refund made in the Stripe Dashboard | `charge.refunded` | I7: cancel if possible, else alert | — |
| Early fraud warning, dispute | Stripe webhook | `fraud` hold / cancel (§05 §4) | evidence for a dispute |
| Webhook lost, shop down | reconciliation | re-fetch and apply | — |
| Crash after create, before our write | lookup at step 3 | adopt | — |
| Returned parcel | webhook | event | reship or refund |
| Damaged or misprinted item | customer contact | — | report to Printful (photo, 30 days); reprint arrives as a new shipment |

## 8. Fail-safes against large or unusual orders

ADR-0020. Normal orders pass untouched; unusual ones never reach Printful without Klaus,
and fail safe. **The threshold values are deployment configuration in kube-setup
(private), not in this public repository** (review 1 F27); the code requires them in live
mode and uses obviously artificial values in tests.

| Layer | Rule | Effect |
|---|---|---|
| Hard limits | per-SKU `maxQuantity` (config), items per order, order total | Checkout refused with the contact address. Checked when the cart changes, at the quote and at checkout. |
| Approval hold | **all** of these are evaluated and stored (review 1 F8): the order total at or above `APPROVAL_OVER_CENTS`; the same e-mail or card fingerprint has paid more than `REPEAT_OVER_CENTS` in total, or at least `REPEAT_ORDERS` orders, in the last 24 h (cumulative, review 1 F7); Radar risk `elevated` or `highest`; the circuit breaker is tripped | `approval` hold with all reasons. Admin **Approve** (recorded: who, when; the check is not re-run) or **Refund**. Deadline: refund (the order is never confirmed, so I4 holds). |
| Circuit breaker | more than `BREAKER_ORDERS_24H` paid orders, or more than `BREAKER_COST_CENTS_24H` provider cost, in 24 h | Breaker trips (stored in `settings`); alert; new paid orders get an `approval` hold with reason `breaker`. **Reset** releases only holds whose sole reason is `breaker`; holds with other reasons stay for a decision. |
| Always | rate limits, Radar, the pre-payment cost check, the cost guard | as described |

Radar's risk level and the card fingerprint come from `expand: payment_intent.latest_charge`;
for some methods they are absent, which is **not** a hold reason.
