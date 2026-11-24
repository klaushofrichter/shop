# 6. Fulfilment

## 1. Principles

- The shop talks to fulfilment providers only through an interface (R13, ADR-0017). Printful is the only implementation at launch.
- Webhooks are **hints**: the shop verifies them, then re-fetches the order from the provider and acts on what the API says (ADR-0018).
- Every call that creates something is **idempotent** by our order id.
- Confirming an order **costs Klaus money**. Confirmation happens only in live mode, after the cost guard, and at most once.

## 2. Provider interface

```ts
interface FulfilmentProvider {
  readonly id: 'printful';

  /** Startup and daily: the print area, DPI and availability of each configured variant. */
  describeVariant(variantId: number): Promise<VariantSpec>;          // { placement, technique, widthPx, heightPx, dpi, available }

  /** Quote page. */
  shippingRates(to: Address, items: ItemRef[]): Promise<ShippingRate[]>; // { methodId, name, amountCents, minDays, maxDays, minDate?, maxDate? }

  /** Admin: preview images. */
  createMockup(req: MockupRequest): Promise<{ taskId: string }>;
  getMockup(taskId: string): Promise<MockupResult>;                  // pending | done(urls) | failed(reason)

  /** Order submission, see §4. All keyed by our order's external id. */
  findOrder(externalId: string): Promise<ProviderOrder | null>;
  createDraft(order: DraftOrder): Promise<ProviderOrder>;            // DraftOrder carries externalId, recipient, items with file URLs, shipping method
  getOrder(providerOrderId: string): Promise<ProviderOrder>;         // status, costs { calculating | done, totalCents, … }, shipments[]
  confirm(providerOrderId: string): Promise<ProviderOrder>;
  cancel(providerOrderId: string): Promise<'canceled' | 'not_cancellable'>;

  /** Webhooks. */
  verifyWebhook(rawBody: Buffer, headers: Headers): boolean;
  parseWebhook(rawBody: Buffer): ProviderEvent;                       // { eventId, type, providerOrderId?, externalId?, occurredAt }
}
```

`ProviderOrder.status` is normalised to: `draft | pending | on_hold | in_production |
partially_shipped | fulfilled | canceled | failed`. Each adapter maps its own
statuses; errors are thrown as `NotCreated` (safe to retry), `Unknown` (look up
before retrying), `Permanent(reason)` (won't succeed by retrying: invalid address,
discontinued variant, rejected file) or `RateLimited(retryAfter)`.

A SKU names its provider; an order whose items belong to two providers would be
split into one provider order per provider. With one provider this never happens;
the schema has `provider_orders` as a separate table so it can.

## 3. Printful adapter

- Base `https://api.printful.com`, `Authorization: Bearer $PRINTFUL_TOKEN` (store-level, so no `X-PF-Store-Id`), 15 s timeout, JSON.
- Reads `X-Ratelimit-Remaining`/`-Reset` on every response; when remaining < 10 the runner pauses Printful jobs until reset. `429` → `RateLimited(Retry-After)`.
- Mapping of an order item:

  ```json
  {
    "source": "catalog",
    "catalog_variant_id": 4651,
    "external_id": "<order_item id>",
    "quantity": 1,
    "retail_price": "59.00",
    "name": "Framed print 8 × 10 in — Undertow",
    "orientation": "vertical",
    "placements": [
      { "placement": "default", "technique": "digital",
        "layers": [ { "type": "file", "url": "https://shop.klaushofrichter.net/files/<sha256>.jpg" } ] }
    ]
  }
  ```

  The print file is already exactly the print area's size, so no `position` is sent (Printful fills the area).
- Order body: `external_id`, `shipping` (the method the customer paid for, e.g. `STANDARD`, sent explicitly), `recipient` (from the order), `order_items`, `retail_costs { currency: "USD", shipping, tax }` (what the customer paid, shown on Printful's side), `customization.packing_slip { store_name: "Klaus Hofrichter Art", message, email, custom_order_id: <order number> }`.
- `external_id`: our order id, `[A-Za-z0-9_-]`, at most 32 characters; Printful never releases a used id, so a resubmission after a cancel uses `<id>-2`, `-3`… (stored on `provider_orders`).
- Lookup by our id: `GET /v2/orders/@<external_id>` (documented in the v2 spec: "Order External ID (string prepended with @ symbol)").
- Cancel: v2 `DELETE /v2/orders/{id}` only deletes drafts, failed or cancelled orders; cancelling a submitted order uses **v1** `DELETE https://api.printful.com/orders/{id}`. Captured 2026-11-24 on a draft: the store-level token works on v1, the order becomes `canceled` and stays visible. (On a confirmed order it can't be observed without a real order.)
- Error mapping from captured responses: duplicate `external_id` → 400 "External ID validation error…" → treat as "exists", look up `@external_id`; unknown variant → 404 → `Permanent`; invalid address → 400 "Recipient: …" → `Permanent` with the message; after a `PATCH`, costs return to `calculating`.

## 4. Submission

Job `order.submit(order_id)`, run when an order becomes `paid` and retried by the
job runner. Steps, each re-entrant:

1. **Claim**: insert `provider_orders(order_id, provider, external_id, state='submitting')`; the unique index on `(order_id, provider)` means a second worker finds the row and continues from its state instead of creating anything.
2. **Look up** `@external_id`. Found → record its id and status; skip to step 4 (or step 6 if already confirmed).
3. **Create draft**. On `Unknown` failure (timeout, 5xx, 409) → back to step 2 on retry; on `NotCreated` → retry; on `Permanent` → §7.
4. **Wait for costs**: poll `getOrder` until `costs.calculation_status = done` (Printful prices drafts asynchronously and refuses confirmation while calculating); up to 10 polls over ~60 s inside the job, then reschedule the job.
5. **Cost guard**: `provider cost total` (items + shipping + tax Printful charges Klaus) must be ≤ (amount paid for items and shipping) − (Stripe fee estimate) − `MARGIN_FLOOR_CENTS` (default 0). Fails → §7 "cost guard".
6. **Confirm** — only if `FULFILMENT_CONFIRM=true` (live). In test mode the order stops as a Printful draft and the shop marks it `submitted (test)`; a nightly job deletes test drafts older than 7 days.
7. Transition `paid → submitted` (cause `job`, ref Printful order id). Store Printful's costs on `provider_orders` for the admin's margin view.

At < 10 orders a week the job runs within seconds of payment; a customer sees
"In production" within a minute or two in the normal case.

## 5. Status and tracking

`POST /webhooks/printful`:

1. Verify: header `x-pf-webhook-signature` = hex HMAC-SHA256 of the **raw body** with the **hex-decoded** `secret_key` returned when the webhook was registered; constant-time compare. If `PRINTFUL_WEBHOOK_PUBLIC_KEY` is set, `x-pf-webhook-public-key` must equal it. Invalid or missing → 401, ignored (per Printful's own docs, v2 spec "Webhook v2" section).
2. Event id = SHA-256 of `type|created|order id|shipment id` (Printful events carry no id), truncated to 32 hex; insert into `inbound_events`; duplicate → 200.
3. Enqueue `printful.event`, answer 200.

Registered once by `scripts/printful-webhook.ts` (`POST /v2/webhooks`, replaces any
existing config for this token): `default_url = https://shop.klaushofrichter.net/webhooks/printful`, events:

| Event | Effect (after re-fetching the order) |
|---|---|
| `order_created`, `order_updated` | Sync status. |
| `order_failed` | §7. |
| `order_canceled` | → `canceled` path, §7. |
| `order_put_hold`, `order_put_hold_approval`, `order_remove_hold` | `on_hold` ↔ back; a hold older than 24 h alerts Klaus. |
| `order_refunded` | Printful refunded Klaus (e.g. after a reported defect); annotate. |
| `shipment_sent` | Upsert a `shipments` row: `carrier`, `service`, `tracking_number`, `tracking_url`, `shipped_at`, `estimated_delivery`, items; → `shipped` or `partially_shipped`; enqueue the shipping email if enabled. |
| `shipment_delivered` | `delivered_at`; when all shipments are delivered → `delivered`. |
| `shipment_returned`, `shipment_canceled`, `shipment_out_of_stock`, `shipment_put_hold` | Annotate; alert Klaus (returned parcels need a decision: reship or refund). |
| `catalog_stock_updated`, `catalog_price_changed` | Refresh SKU availability/prices ([04 §7](04-catalog-and-print-files.md#7-availability)). |
| `mockup_task_finished` | Wake the mockup job. |

The v2 `Shipment` object carries `carrier`, `service`, `tracking_number`,
`tracking_url`, `tracking_events`, `shipped_at`, `delivered_at`, `estimated_delivery`,
`is_reshipment` and `shipment_items` (confirmed in the v2 spec). A reshipment (reprint)
is just another shipment row.

Polling backs the webhooks up: reconciliation re-fetches every open order hourly
([07 §5](07-orders-data-jobs.md#5-reconciliation)).

## 6. Cancellation

- Before confirmation (draft): delete the draft (v2 `DELETE`).
- After confirmation, before production (`pending`, `on_hold`): v1 cancel; Printful refunds Klaus's wallet.
- In production or later: not cancellable. The shop refuses a "cancel" from the admin and offers "refund anyway" (Klaus's explicit choice: the item still ships).
- Customers can't cancel by themselves at launch (contact link; R9 accepts this rare manual case).

## 7. Failure handling

Goal (Q1, R9): every paid order ends shipped or refunded **without Klaus**, except
where only he can act (his Printful billing, a returned parcel, a dispute).

| Failure | Detected by | Automatic handling | Klaus |
|---|---|---|---|
| Printful API down, 5xx, timeout, 429 | submit job | Retry with backoff: 1, 2, 5, 10, 30 min, then every hour, up to **24 h** from payment. Look up `@external_id` before every create. | Alert only if still failing after 24 h. |
| Permanent create error (invalid address, variant discontinued, file rejected) | submit job (`Permanent`) | Delete the draft, **full refund**, customer email (if enabled) and status page "Refunded — we couldn't produce this order". | FYI alert. |
| Cost guard fails (Printful costs more than paid) | submit step 5 | Keep the draft, `needs_attention`, wait **24 h** for Klaus to "confirm anyway" in the admin; then cancel and **refund automatically**. | Decide within 24 h, or let it refund. |
| Printful `order_failed` / on hold for **billing** (Klaus's card or wallet) | webhook, poll | `on_hold`; alert Klaus at once (only he can fix billing); after **72 h** on hold: cancel and refund. | Fix billing. Prevention: auto-recharge on his Printful wallet. |
| Other holds (Printful review, approval) | webhook, poll | Wait; Printful usually resolves; after 72 h alert. | Rarely. |
| Printful cancels the order | `order_canceled` | Full refund unless already refunded; customer email. | FYI. |
| Webhook lost | hourly reconciliation | Re-fetch and apply. | — |
| Shop down during webhooks | provider retries (Stripe 3 days; Printful 1–1024 min), reconciliation | Apply on recovery. | — |
| Crash between Printful create and our write | step 2 lookup on retry | Adopt the existing Printful order. | — |
| Returned parcel (bad address, refused) | `shipment_returned` | Annotate; Printful keeps returns 30 days. | Decide: reship (new order, paid by Klaus or customer) or refund. Rare. |
| Damaged or misprinted item | customer contact | — | Report to Printful (photo, within 30 days); Printful reprints free → arrives as a new shipment. |
| Dispute / chargeback | Stripe webhook | Annotate, alert with the tracking evidence ready in the admin. | Submit evidence in Stripe. |

All windows (24 h, 72 h) are configuration (ADR-0010 sets them; proposed values shown).
Klaus's "involvement" is limited to the right column; none of it is in the happy path.

## 8. Fail-safes against large or unusual orders

ADR-0020 (Klaus: "a fail save and protection against large orders … not misuse"). Normal
orders pass untouched; unusual ones never reach Printful without Klaus, and fail safe to
a refund.

| Layer | Rule (defaults, configurable) | Effect |
|---|---|---|
| Hard limits | quantity per item ≤ 10 (postcards ≤ 25), ≤ 20 items, total ≤ $500 | Checkout refused; contact address offered. Checked at `POST /cart`, `/cart/address` and `/checkout`. |
| Approval hold | total ≥ $250; or the same email or card fingerprint paid another order in the last 24 h; or Stripe Radar risk level `elevated`/`highest` | After payment the order goes to `awaiting_approval` instead of submission; alert to Klaus with the reasons. Admin: **Approve** → submit; **Refund** → refund. **No action in 72 h → automatic full refund.** |
| Circuit breaker | > 10 paid orders in 24 h, or > $600 provider cost of submitted orders in 24 h | Breaker trips (stored in the database, survives restarts); alert; every newly paid order is held as above. Admin: **Reset breaker** releases the held orders to normal processing. Quotes and payments keep working. |
| Always | per-IP rate limits, Stripe Radar, cost guard (§4 step 5) | as described there |

The check runs once, in the job that follows `paid`, in this order: breaker tripped?
→ hold. Hold conditions? → hold. Otherwise submit. Radar's risk level is read from the
charge of the PaymentIntent (`outcome.risk_level`). The card fingerprint is
`payment_method_details.card.fingerprint` (stored on the order, not the card number).

