# 5. Quote, checkout and payment

## 1. Money

- USD only (ADR-0011). All amounts are integer cents. Printful returns decimal strings (`"8.49"`); the adapter converts with exact decimal parsing (no floats).
- Item prices come from the offer ([04 §3](04-catalog-and-print-files.md#3-offers-and-prices)), shipping from Printful's quote, tax (if enabled) from Stripe. **No amount is accepted from the browser** (Q3): the browser sends SKU ids, quantities, an address and a shipping option id.

## 2. Quote

`POST /cart/address` → `quote.create(cart, address)`:

1. Validate the address ([03 §4](03-customer-journey.md#4-cart-and-address)) and that the country is enabled.
2. Call the provider: Printful `POST /v2/shipping-rates`

   ```json
   {
     "recipient": { "name": "Jane Doe", "address1": "1 Main St", "address2": null, "city": "Austin",
                    "state_code": "TX", "zip": "78701", "country_code": "US", "phone": null },
     "order_items": [
       { "source": "catalog", "catalog_variant_id": 4651, "quantity": 1 },
       { "source": "catalog", "catalog_variant_id": 11513, "quantity": 4 }
     ],
     "currency": "USD"
   }
   ```

   Response (per option): `shipping` (method id, e.g. `STANDARD`), `shipping_method_name`, `rate`, `currency`, `min/max_delivery_days`, `min/max_delivery_dates` (may be absent), `shipments[]` (one entry per departure facility, with `customs_fees_possible`). Confirmed against the v2 OpenAPI spec, 2026-11-24.
3. Keep at most 3 options: `STANDARD` first, then by price. A `400` "cannot ship" means no option: the quote page says so.
4. Optional shipping markup: `SHIPPING_MARKUP_CENTS` per order (default 0; Klaus's choice).
5. Store a **quote** row: cart snapshot (SKU, variant, quantity, unit price), normalised address, options, `expires_at = now + 30 min`. The quote id goes into the cart.

Caching: an identical request (same variants, quantities, country, state, zip) within 5 minutes reuses the previous response, which protects the 120 requests/minute limit and makes "back" cheap.

Rate limit on the public side: quotes are limited per client IP (e.g. 20 per 10 minutes), since each one costs a Printful call ([10 §2](10-security-privacy-legal.md#2-threats-and-controls)).

## 3. Checkout Session

`POST /checkout` (body: quote id, chosen shipping option id, CSRF token; checkbox "I agree to the terms of sale" if Stripe's own consent collection is not used):

1. Re-validate: hard limits (ADR-0020: quantity per item, items per order, order total) — exceeded → the cart page with a message; quote exists, not expired, belongs to this cart; every offer still enabled, its print file ready, its price unchanged; the chosen option is in the quote. On any change → re-quote and show `/quote` again with a notice.
2. Create the **order** in one transaction: `orders` row (state `checkout_open`, order number, status token hash, address, email, shipping method and amount, item subtotal, expected total excluding tax), `order_items` rows (copies of SKU name, variant, picture title, unit price, quantity, print file hash), and a transition row (cause `storefront`).
3. Create a **Stripe Customer** for this order:
   ```
   customers.create({ email, name, phone,
     address:  { line1, line2, city, state, postal_code, country },   // for tax
     shipping: { name, phone, address: { … same … } },
     metadata: { order_id } })
   ```
   One Customer per order (no accounts). This lets Checkout show the address the customer already typed, keeps the paid-for address identical to the quoted one, and gives Stripe Tax its address (ADR-0023).
4. Create the **Checkout Session** with `Idempotency-Key: checkout-<order_id>`:

   | Parameter | Value |
   |---|---|
   | `mode` | `payment` |
   | `customer` | the Customer from step 3 |
   | `client_reference_id` | order id |
   | `metadata.order_id`, `payment_intent_data.metadata.order_id` | order id |
   | `line_items[]` | per item: `price_data { currency: usd, unit_amount, tax_behavior: exclusive, product_data { name: "Framed print 8 × 10 in, black frame — Undertow", images: [mockup URL], tax_code } }`, `quantity` |
   | `shipping_options` | exactly one: `shipping_rate_data { type: fixed_amount, fixed_amount { amount, currency: usd }, display_name, delivery_estimate { minimum/maximum business_day }, tax_behavior: exclusive, tax_code: txcd_92010001 }` *(verify that `shipping_options` works without `shipping_address_collection`; fallback: shipping as a separate line item "Shipping — Standard")* |
   | `shipping_address_collection` | not set: the address comes from the Customer |
   | `billing_address_collection` | `auto` |
   | `automatic_tax.enabled` | `TAX_ENABLED` (ADR-0012) |
   | `consent_collection.terms_of_service` | `required` (needs the terms URL set in the Stripe Dashboard) |
   | `payment_method_types` | not set (Dashboard decides); the Dashboard should enable only **immediate** methods (cards, Apple Pay, Google Pay, Link) so payment is never delayed |
   | `allow_promotion_codes` | `false` (out of scope) |
   | `expires_at` | now + 60 min |
   | `success_url` | `https://shop…/order/<id>?t=<token>&from=checkout` |
   | `cancel_url` | `https://shop…/checkout/cancelled?o=<id>&t=<token>` |

5. Store `stripe_customer_id`, `stripe_checkout_session_id`; `303` to `session.url`.

If step 3 or 4 fails: the order goes to `abandoned` (cause `storefront`, note with the
error), the customer sees "Payment is unavailable right now, please try again", and no
Stripe object is left that could be paid.

## 4. Payment webhooks

`POST /webhooks/stripe` (raw body, before any JSON parser):

1. Verify `Stripe-Signature` with the webhook secret of the current mode (300 s tolerance). Invalid → 400, nothing stored.
2. Insert into `inbound_events` (provider `stripe`, `event.id` unique). A duplicate → 200 with no further work.
3. Enqueue a job `stripe.event(<event id>)` and answer **200 immediately**.

Events subscribed (and nothing else):

| Event | Job does |
|---|---|
| `checkout.session.completed` | Re-fetch the session (`expand: payment_intent`). If `payment_status = paid`: check `currency = usd`, `amount_subtotal` = order's item subtotal, `shipping_cost.amount_total` = order's shipping, `customer` = order's customer; record `amount_total`, `total_details.amount_tax`, `payment_intent` id; transition `checkout_open → paid`; then the **fail-safe check** ([06 §8](06-fulfilment.md#8-fail-safes-against-large-or-unusual-orders)) either enqueues `order.submit` or moves the order to `awaiting_approval`. A mismatch → `needs_attention` with a note (should never happen: we created the session). If `unpaid` (delayed method): stay, wait for the async events. |
| `checkout.session.async_payment_succeeded` | Same as completed-and-paid. |
| `checkout.session.async_payment_failed` | `checkout_open → payment_failed` (terminal). |
| `checkout.session.expired` | `checkout_open → expired` (terminal). |
| `charge.refunded` | Record refunded amount (full → `refunded`; partial → annotation). Covers refunds made in the Stripe Dashboard too. |
| `charge.dispute.created`, `charge.dispute.closed` | Annotate the order; alert Klaus (a dispute needs evidence: the shipment's tracking). |

Webhook endpoint registration is a one-time script (`scripts/stripe-webhook.ts`)
run per mode; it prints where the signing secret must go, never the secret. Stripe
retries undelivered events for up to 3 days (live); reconciliation covers the rest
([07 §5](07-orders-data-jobs.md#5-reconciliation)).

## 5. The return to the shop

The success page does not wait for the webhook: if the order is still
`checkout_open`, the page handler re-fetches the Checkout Session (id stored on the
order) and, if paid, performs the same transition as the webhook job (idempotent: the
conditional update lets only one of them win). So the customer sees "Payment received"
at once, and a lost webhook does not leave the order unpaid in the shop.

## 6. Tax

ADR-0012 (accepted): collect sales tax as legally required, via Stripe Tax; background
and Klaus's steps in [research/sales-tax.md](../research/sales-tax.md).

- `TAX_ENABLED=true` in live mode once Klaus's registration is in Stripe Tax (and a test-mode registration for testing). Stripe calculates only for states with a registration; elsewhere the tax is $0, which is correct while the shop is below other states' thresholds.
- Prices are tax-exclusive; the quote page says "Sales tax, if any, is calculated on the payment page".
- Tax codes in `config/skus.json` per SKU kind: `txcd_99999999` (general tangible goods) for prints, framed prints, postcards and mugs; the clothing code for t-shirts (probably `txcd_30011000`, *(verify)* with `GET /v1/tax_codes`); `txcd_92010001` on the shipping rate.
- After payment the shop stores `total_details.amount_tax` on the order and each line's tax (from the session's line items, `expand: line_items`), with the ship-to state and ZIP.
- The admin exports, per period and state: items, shipping, tax collected, refunds (CSV), to cross-check Stripe's tax report when filing.
- Address source: the Customer's address (ADR-0023), *(verify)* that Stripe Tax uses it; fallback: Checkout collects the shipping address restricted to the quoted country and the shop compares it with the quote.
- Printful separately charges Klaus tax on wholesale unless his resale certificate is on file (his step, not software).

## 7. Refunds

- **Full refund**: `refunds.create({ payment_intent, reason: 'requested_by_customer' | 'duplicate' | 'fraudulent', metadata: { order_id } })` with `Idempotency-Key: refund-<order_id>-full`. Used by the failure policy ([06 §7](06-fulfilment.md#7-failure-handling)) and by the admin.
- **Partial refund** (admin only, e.g. one damaged item after Printful refused a reprint): amount entered by Klaus, idempotency key with a counter.
- Before refunding a paid order that reached Printful, the job cancels the Printful order if it is still cancellable ([06 §6](06-fulfilment.md#6-cancellation)); a refund never happens while Printful may still ship, except by Klaus's explicit choice.
- Stripe keeps its fee on refunds; a refunded order costs Klaus about 2.9% + 30¢.

## 8. Keys and modes

| Variable | Use |
|---|---|
| `STRIPE_MODE` | `test` (default) or `live` |
| `STRIPE_SECRET_KEY` | the restricted key of the current mode; the pod only ever holds one. Built by `scripts/create-secrets.sh` from the node's `STRIPE_TEST_TOKEN`, or from `STRIPE_LIVE_TOKEN` at go-live ([11 §1](11-operations.md#1-deployment)). The process refuses to start if the key's prefix (`rk_test_`/`rk_live_`) doesn't match `STRIPE_MODE`. |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` of that mode's endpoint registration |

Restricted key permissions (set by Klaus, identical in both modes): Checkout Sessions
write, Customers write, Refunds write, PaymentIntents read, Charges read, Events read,
Disputes read; everything else none. (Customers write is needed for §3 step 3; it was
missing from the first list given to Klaus.)
