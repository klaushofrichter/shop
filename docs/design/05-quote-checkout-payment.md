# 5. Quote, checkout and payment

Revised for review round 2 (2026-11-25): cart with any pictures (ADR-0026), quote
without Printful's estimation task but with a pre-payment cost check (ADR-0036), one
open checkout per cart, shipping compared without tax, Stripe webhook endpoints with a
pinned version (ADR-0030), more Checkout parameters, refund details. Round 2 fold-in
(2026-11-26): the payment transaction runs the fail-safes, refunds are records, only a
full refund cancels, line items are paged.

## 1. Money

- USD only (ADR-0011). Integer cents everywhere. Printful's decimal strings are converted at the adapter boundary with exact decimal parsing.
- Prices come from the offers, shipping from Printful's rates, tax from Stripe. **The browser sends only ids, quantities, an address and a shipping option id** (Q3).

## 2. Quote

`POST /cart/address` → `quote.create(cart, address)`:

1. **Validate the address locally**: required fields ([03 §4](03-customer-journey.md#4-cart-and-address)); the country is enabled; **ZIP ↔ state** consistency from a static ZIP-prefix table (< 1 KB, no network; built from USPS's published ZIP-prefix list, with the documented cross-state exceptions as test cases; an unknown prefix is accepted). A mismatch blocks with the contact address, and the admin counts these rejections so a false one is seen (review C F16). The captures showed Printful's own checks catch exactly this and nothing more (no street validation), so the local table gives the same protection in under a millisecond (review 2 F6). A wrong street can only surface later as a returned parcel ([06 §7](06-fulfilment.md#7-failure-handling)).
2. **Shipping rates**: Printful `POST /v2/shipping-rates` with the recipient's country, state, ZIP, city and street, and every cart item as `{source: catalog, catalog_variant_id, quantity}` (integers; strings are rejected). One call, ~1 s (Q6 holds). Keep at most 3 options, `STANDARD` first. (The captures show Printful offering `STANDARD` and `STANDARD_CARBON_OFFSET` for the launch products, no express method.) A `400`/`404` "cannot ship" → the page says which item can't ship there.
3. **Pre-payment cost check** (review 1 F9, ADR-0036): estimated provider cost = Σ (cached wholesale price of the variant × quantity, from the daily catalog refresh) + the quoted shipping rate + an allowance for the sales tax Printful charges Klaus (`PROVIDER_TAX_ALLOWANCE_PCT`, until his resale certificate is on file). If `items + shipping − Stripe fee estimate − estimated provider cost < MARGIN_FLOOR_CENTS`, **Pay is not offered** ("This combination can't be ordered right now") and Klaus gets an alert: it means a price is misconfigured. Customer tax never counts as revenue.
4. Optional shipping markup (`SHIPPING_MARKUP_CENTS`, default 0).
5. Store the **quote** (items with unit prices, normalised address, options, `est_cost_cents`, `expires_at = now + 30 min`) and link it to the cart.

"Normalised address": trimmed, internal whitespace collapsed, US state as its two-letter
code, ZIP as 5 or 9 digits with a hyphen, the country code upper-case, line 2 empty →
null. Printful accepts Latin characters; non-Latin input is refused with a message.
PO boxes are allowed (USPS delivers them; Printful ships standard by USPS); APO/FPO/DPO
and US territories are not in the launch list (ADR-0011 scope).

The public quote endpoint is rate-limited per client address (each quote costs one
Printful call).

## 3. Checkout Session

`POST /checkout` (CSRF token, the quote id, the chosen shipping option):

1. **One open checkout per cart** (I9, review 1 F2). If the cart has an `open_order_id` whose session is still open and whose quote and option are unchanged → redirect to that session's URL again. If anything changed → expire that session at Stripe; only when the expire succeeds (or the session is already `expired`) does the request continue. If Stripe refuses because the session is **complete**, the customer has paid in another tab: `payment.apply` runs and the request redirects to the status page (reviews A F12, B F10). A double-click is caught by the same rule, and the unique index (I9) catches a race.
2. Re-validate: limits ([06 §8](06-fulfilment.md#8-fail-safes-against-large-or-unusual-orders)), quote not expired, every offer still enabled with a ready print file, prices unchanged. On any change → re-quote, show `/quote` with a notice.
3. Create the **order** in one transaction: `orders` row (`payment_state = checkout_open`, order number, address and e-mail from the quote, shipping, amounts, `checkout_idempotency_key`), `order_items` (each `print_file_sha` checked against the catalog), an `order_events` row; set `carts.open_order_id`.
4. Create a **Stripe Customer** for this order (ADR-0023): e-mail, name, `address` and `shipping` = the quoted address (Stripe Tax reads it), metadata `order_id`. No phone (ADR-0031).
5. Create the **Checkout Session**, `Stripe-Version: 2026-11-18.endive`, `Idempotency-Key: checkout-<order id>`:

| Parameter | Value |
|---|---|
| `mode` | `payment` |
| `customer` | from step 4 |
| `client_reference_id`, `metadata.order_id`, `payment_intent_data.metadata.order_id` | order id |
| `payment_intent_data.description` | `Order 48213` (so Stripe's receipt names the order) |
| `payment_intent_data.shipping` | the recipient (Radar uses it; dispute evidence starts there) |
| `payment_method_types` | set in code: `card` and `link` only (cards cover Apple Pay and Google Pay). No delayed method can be enabled by a Dashboard toggle. |
| `line_items[]` | per item: `price_data { currency: usd, unit_amount, tax_behavior: exclusive, product_data { name: "Framed print 12 × 16 in, black — <title>", images: [display image URL], tax_code, metadata: { order_item_id } } }`, `quantity` |
| `shipping_options` | exactly one, `shipping_rate_data { type: fixed_amount, fixed_amount, display_name, delivery_estimate, tax_behavior: exclusive, tax_code: txcd_92010001 }`. Works without `shipping_address_collection` (captured). |
| `shipping_address_collection` | not set |
| `custom_text.submit.message` | "Ships to Jane Doe, 1 Main St, Austin, TX 78701" (Stripe's page doesn't show the Customer's address otherwise; review 1 F13) |
| `billing_address_collection` | `auto` |
| `automatic_tax.enabled` | `true` when Stripe Tax is configured for the mode (ADR-0012) |
| `consent_collection.terms_of_service` | `required` (terms URL set in the Stripe Dashboard) |
| `allow_promotion_codes` | `false` |
| `expires_at` | now + **30 min** (Stripe's minimum; narrows every window) |
| `success_url` | `<PUBLIC_URL>/order/<id>?t=<token>&from=checkout` |
| `cancel_url` | `<PUBLIC_URL>/cart?from=checkout` (side-effect free, §5) |

6. Store the Customer and Session ids; `303` to `session.url`. If the process dies between 5 and 6, reconciliation recovers the session with the same idempotency key ([07 §2.1.1](07-orders-data-jobs.md#211-a-lost-session-id)).

This full parameter set has not been sent together yet; one test-mode create is on the verify list ([13 §4](13-plan-and-open-questions.md#4-items-to-verify)).

Errors: `customer_tax_location_invalid` from Stripe Tax → the address form, with the
message (it validates the Customer's address and does not fall back). Any other Stripe
failure where Stripe answered with an error → no session exists: the order goes to `closed_unpaid` (07 §2.1 includes "no session was ever created") and the cart is unchanged; "Payment is unavailable right now". No answer at all → the order stays `checkout_open` and §2.1.1 of 07 resolves it.

## 4. Payment webhooks

**Endpoints** (ADR-0030): one per mode, created by Klaus in the Stripe Dashboard with
the **latest** API version (the Dashboard can't pin an older one; review C F7), the URL
`<PUBLIC_URL>/webhooks/stripe`, and exactly the events below. The endpoint's version
doesn't matter: handlers use three fields and re-fetch with the pinned version. The admin's
System page shows the version of the last event next to the pinned one. The test-mode
endpoint is disabled at go-live (ADR-0029). The signing secret goes into the node's
`.env` as `STRIPE_TEST_WEBHOOK_SECRET` / `STRIPE_LIVE_WEBHOOK_SECRET`.

`POST /webhooks/stripe` (raw body): verify `Stripe-Signature` (300 s tolerance) → insert
into `inbound_events` (unique event id; duplicate → 200) → enqueue → 200.

**Handlers use only `event.id`, `event.type` and `data.object.id` from the payload**; every
other value comes from a re-fetch with the pinned version (review 1 F12). A test fixture
in the 2017 shape proves it.

| Event | Job does (after re-fetch) |
|---|---|
| `checkout.session.completed`, `checkout.session.async_payment_succeeded` | `payment.apply` ([07 §2.1](07-orders-data-jobs.md#21-checkout-and-payment-payment_state)). Reads: the session (`expand: payment_intent.latest_charge`) and **all** its line items (`limit=100`, paged on `has_more`; review C F6). Checks: currency, `amount_subtotal` = items, **`shipping_cost.amount_subtotal`** = shipping (not `amount_total`, which includes tax where shipping is taxed; review 1 F3), `amount_total = amount_subtotal + shipping subtotal + total_details.amount_tax`, and the lines' tax (matched by `metadata.order_item_id`) sums to `amount_tax` minus the shipping tax. Then **one transaction**: `paid` from `checkout_open` **or `closed_unpaid`** (I1), amounts, tax per line, PaymentIntent, card fingerprint and Radar risk level (absent for some methods: not a hold reason), every fail-safe ([06 §8](06-fulfilment.md#8-fail-safes-against-large-or-unusual-orders)), the hold or the submit job, `failsafe_checked_at`, the cart emptied. A mismatch → `paid` is still recorded with an `attention` hold (`amount_mismatch`). |
| `checkout.session.async_payment_failed` | `closed_unpaid` (no delayed methods are enabled; kept as a safety net) |
| `checkout.session.expired` | `closed_unpaid` |
| `charge.refunded`, `refund.updated`, `refund.failed` | Re-read the charge's `amount_refunded`: `partially_refunded` / `refunded`; update the `refunds` row (a refund made in the Dashboard gets a row with purpose `dashboard`). **Only a full refund** applies I7 and resolves the open holds; a partial refund is an event and a line on the status page (reviews A F2, B F1). A failed refund → hold reason `refund_failed`. |
| `radar.early_fraud_warning.created` | `dispute_state = warning`. Not yet confirmed → `fraud` hold and an **immediate** refund (I4 holds trivially once the draft is deleted). Confirmed and cancellable → cancel, then refund. Otherwise alert. Klaus can resolve the hold as a false alarm (`warning → none`). |
| `charge.dispute.created`, `charge.dispute.closed` | `dispute_state` ([07 §2.2](07-orders-data-jobs.md#22-disputes-dispute_state)). Created: not confirmed → `fraud` hold (reason `dispute`, action `alert`, **never a refund**); open fraud holds switch to `alert`; confirmed → cancel if cancellable; alert with the order number and an admin link. Closed: resolve the hold (`won`: Klaus decides on fulfilment; `lost`: closed). |

Stripe retries for up to 3 days (live). Reconciliation covers the rest ([07 §5](07-orders-data-jobs.md#5-reconciliation)).

## 5. Return from Stripe

- **success_url**: exchanges the token for a cookie and redirects to the clean URL ([03 §7](03-customer-journey.md#7-order-status-page)). If the order is still `checkout_open`, the handler re-fetches the session and, if paid, performs the same transition as the webhook (conditional update: only one wins). The page refreshes itself while "confirming your payment".
- **cancel_url**: shows the cart. **It changes nothing** (a GET with side effects is also triggered by link previews and history). The open session stays payable until it expires (≤ 30 min) or the next `POST /checkout` expires it (§3 step 1). If the customer pays it after all, that is a normal payment (I1).

## 6. Tax

ADR-0012: Stripe Tax wherever Klaus is registered; tax-exclusive prices; tax codes
`txcd_99999999` (prints, framed prints, postcards, mugs), `txcd_30011000` (t-shirts,
captured), `txcd_92010001` (shipping). Per order and per line the tax is stored from the
session. Stripe's own tax report is what gets filed (review 1 F29: no separate tax page).
The quote page says "Sales tax, if any, is calculated on the payment page". Stripe Tax
amounts are verified once Klaus adds a test-mode registration, with one state that taxes
shipping (Texas) and one that doesn't.

## 7. Refunds

- Before any refund, read the charge's `amount_refunded`; the idempotency key (`refund-<order>-<n>`) lives only 24 h at Stripe. `charge_already_refunded` counts as success. A refund is final only when it succeeds (`refund.updated`).
- Write a `refunds` row (`requested`, purpose, amount) first; a shop-issued full refund blocks confirm from then on (I2, I3). Then the refund, then I7.
- Success → `succeeded`. Failure (`refund.failed`, a permanent API error) → `failed`, and the order gets a hold (`refund_failed`) with the admin actions "retry refund" and "fulfil anyway"; fulfilment is possible again once no refund is requested (review A F3). `charge_disputed` is final, not retried.
- Full refunds: automatic per the hold rules (I4), or by Klaus in the admin. **Partial refunds** are made in the Stripe Dashboard; the shop records them and changes nothing else.
- Stripe keeps its fee on refunds (about 2.9% + 30¢).

## 8. Keys and modes

| Item | Value |
|---|---|
| Mode | `SHOP_MODE = mock | test | live` (ADR-0029) decides everything below |
| API key | `STRIPE_SECRET_KEY`, built from the node's `STRIPE_TEST_TOKEN` (test) or `STRIPE_LIVE_TOKEN` (live); a mock key in mock mode. The process refuses to start if the prefix doesn't match the mode. |
| Webhook secret | `STRIPE_WEBHOOK_SECRET` of that mode's endpoint |
| API version | pinned in code, `2026-11-18.endive` (stripe-node 23) |
| Restricted key permissions | Checkout Sessions write, Customers write, Refunds write, PaymentIntents read, Charges read, Events read, Disputes read, Radar early fraud warnings read; everything else none. Webhook endpoints are **not** in the key's permissions: Klaus creates them in the Dashboard (ADR-0030). |
