# What the real APIs did (capture of 2026-11-24)

Recorded by `scripts/capture/capture-apis.mjs` (commit 4171148), run by Cluster on the
node with Klaus's permission: Stripe **test** key, Printful reads and **drafts** only.
Data: branch `capture/2026-11-24`, commit b6e43e0, `captures/2026-11-24/` (22 scenario
files). Three drafts were created and deleted (rechecked: 404); nothing was confirmed.
The Stripe account id was replaced by `acct_REDACTED` before committing.

## Printful

| Observation | Evidence | Consequence |
|---|---|---|
| `POST /v2/orders` creates a draft with `costs.calculation_status: calculating`; ~2–3 s later `done` | draft-order-lifecycle: POST, GET (calculating), GET (done) | The submit job's cost wait (06 §4 step 4) is real and short; the mock delays `done` by a configurable 2 s. |
| A draft of framed 8×10 + 2 postcards + t-shirt M to Austin TX cost **$56.36**: shipping $16.34, **tax $4.28** | same | Printful charges Klaus sales tax on wholesale (no resale certificate yet), as the tax research said. Shipping is not cheap for mixed carts (two facilities). |
| `PATCH` on a draft returns it with costs back to `calculating` | lifecycle | After any change, wait for costs again. |
| `GET /v2/orders/@<external_id>` works; v1 `GET /orders/@<external_id>` too | lifecycle | Confirms the lookup the submit algorithm relies on. |
| Duplicate `external_id` → **400** `"External ID validation error. external_id must be unique per store, … is already used by store …"` | lifecycle | The adapter maps this message to "already exists" and looks the order up instead of failing. |
| `DELETE /v2/orders/{id}` on a draft → **204**, then `GET` → 404 | lifecycle | As documented. |
| v1 `DELETE /orders/{id}` on a draft → **200**, status **`canceled`**; the order **stays** (GET 200, status canceled); a v2 DELETE afterwards → 204 | draft-v1-cancel | v1 DELETE cancels rather than deletes. The store-level token works on v1. Cancelling a confirmed order this way is still unverifiable without a real order. |
| Invalid address (state/ZIP mismatch, bad state) → **400** at draft creation: `"Recipient: Shipping address state and ZIP code don't match…; Recipient: Invalid state code"` | draft-errors | Printful validates the address **when the order is created**, i.e. after payment in our flow. Shipping rates don't catch it (they need only country/state/ZIP). → validate before payment (see below). |
| Unknown variant → **404** `"Variant with ID: … does not exist."` | draft-errors, shipping-rates-errors | `Permanent`. |
| **A draft with an unreachable print-file URL is accepted (200)**, placements show no status | draft-errors (bad-file-url) | The broken file would only fail at confirmation or production. → never rely on Printful to reject a bad file; register print files in Printful's file library when an offer is enabled and require it to be processed OK (ADR-0019, updated in 04 §5.4). |
| Shipping rates: missing state → 400 "State code is missing"; bad state → 400; unknown variant → 404; variant id as a string → 400 "must be of type `int`" | shipping-rates-errors | Error shapes for the mock: `{ data: "<message>", error: { reason, message } }`. |
| Order estimation task: `pending` twice, then `completed` with full `costs` and `retail_costs` | order-estimation | An exact cost without creating an order: usable at quote time (see below). |
| Mockup task: `pending` four times (~20 s), then `completed` | mockup-task | Mock delay ~20 s; polling every 5 s is fine. |
| File library: `POST /v2/files` → `status: waiting` | files | See the second capture. |
| Rate-limit headers on v2: `x-ratelimit-limit: 120`, `x-ratelimit-policy: 120;w=60;`, `x-ratelimit-remaining`, `x-ratelimit-reset: 0.5` (seconds, leaky bucket); v1 uses a fixed window (`reset: 32`) | every response | The mock emits the same headers; the adapter reads `remaining`/`reset`. |
| Latency ~0.9 s per call, ~2.5 s to create an order | every response | Quote page: one shipping-rates call ≈ 1 s (Q6 holds). |

## Stripe (test mode)

| Observation | Evidence | Consequence |
|---|---|---|
| **The account's default API version is `2017-04-06`.** | `stripe-version` header on every response | The shop must pin its API version explicitly (stripe-node 23.2.0 pins `2026-11-18.endive`). Response shapes in this capture are the old ones; the second capture uses the pinned version. |
| A Checkout Session with one fixed `shipping_options` entry and **no** `shipping_address_collection` is accepted: `amount_total` 8349 = items 7500 + shipping 849 | checkout-sessions #0 | ADR-0023 works: the customer types the address once, on our page. |
| `automatic_tax.enabled` with the address only on the Customer: accepted, `automatic_tax.status: complete`, tax 0 | checkout-sessions #1, #2 | Stripe Tax takes the Customer's address. Tax is 0 because no test-mode registration exists; amounts to be checked once Klaus adds one. |
| Idempotency key reused with different parameters → 400 "Keys for idempotent requests can only be used with the same parameters…" | #4 | Mock replicates. |
| Negative amount → 400 "Invalid non-negative integer" | #5 | Mock validates the parameters the shop sends. |
| Expire → `status: expired`, `url: null` | #7, #8 | As designed (cancel_url handling). |
| `txcd_30011000` = "Clothing & Footwear" | tax-codes | T-shirt tax code confirmed. |
| Unknown session / refund for unknown PaymentIntent → 404 | errors | Error shapes for the mock. |
| No 403 anywhere | all | The restricted test key has every permission used, Customers write included. |

## Second capture (2026-11-24, branch `capture/2026-11-24b`, commit 065f68c; no drafts)

| Observation | Consequence |
|---|---|
| **Order estimation** rejects a state/ZIP mismatch and an invalid state immediately (**400**, same messages as order creation), but **accepts** a nonexistent street and a missing `address1` (task `completed`, no `failure_reasons`). | The estimate at quote time catches state/ZIP errors before payment. **Printful does not validate street addresses at all**, so the shop's form requires the street line, and a genuinely wrong street surfaces only as a returned parcel (06 §7 `shipment_returned`). Street-level validation would need an address service; not worth it at this volume (open question for the review). |
| **File library**: `POST /v2/files` → `status: waiting`; within ~5–10 s `ok` (with `width`, `height`, `size`, `mime_type`, `filename`; `dpi` null) or **`failed`** for an unreachable URL and for a non-image. Registering the same URL again returns the same file id (de-duplicated by URL). | The offer-enable job registers the print file and waits for `ok`; `failed` blocks the offer with an alert. Content-addressed URLs make de-duplication harmless. Three capture entries remain in Klaus's file library (ids 1121270646, 1121274918, 1121275005). |
| **File library entries can't be deleted through the API** (checked by Cluster 2026-11-24 when Klaus asked to remove the three capture entries): v2 `DELETE /v2/files/{id}` → 404 "Not found" while `GET` → 200; v1 `DELETE /files/{id}` → 404. Removal is possible only in Printful's dashboard. | The shop never plans to clean up entries it registers: the library only grows. At this scale (~25 pictures × up to 11 SKUs, plus re-renders after crop changes) that is a few hundred entries over years; Printful de-duplicates by URL, so re-registering an unchanged file adds nothing. The mock has no file delete either. |
| **Stripe with the pinned version `2026-11-18.endive`**: `shipping_cost { amount_subtotal, amount_tax, amount_total, shipping_rate }` and `total_details.amount_shipping` are populated (both were absent under the account default 2017-04-06). | The shop reads shipping from `shipping_cost.amount_total`, tax from `total_details.amount_tax`. The mock uses the pinned version's shapes, seeded from this capture. |

## Design changes from this capture

1. **Pin the Stripe API version** (`2026-11-18.endive` with stripe-node 23) in the shop and the mock (05 §8).
2. **Validate the address before payment** with a Printful order-estimation task at quote time (no order is created): if Printful rejects the address there, the customer fixes it before paying, instead of a refund after paying. Second capture: it validates state/ZIP like order creation; neither validates the street.
3. **Print files through Printful's file library** at offer enablement, offered only when processing succeeds (04 §5.4); the order then references the file, so a broken file can't reach a paid order.
4. Adapter error mapping from the observed messages (duplicate external id → look up; 404 variant → Permanent; 400 address → Permanent with the message shown in the admin).
5. Mock parameters from the measurements: cost calculation 2 s, mockup 20 s, latency 0.9 s, the exact rate-limit headers and error shapes.

## Still not observable (by Klaus's rule: no real order)

Confirmation, production, shipments and tracking, cancelling a confirmed order, `order_failed` after confirmation, webhooks for those events. These rely on the v2 OpenAPI spec and Printful's documented examples; the mock follows them, and the first real order at go-live (12 §4) is the check.
