# 3. Customer journey

All pages are server-rendered HTML with a little progressive-enhancement JavaScript
(quantity steppers, address autocomplete off by default). Every page works without
JavaScript; forms POST and redirect (POST/redirect/GET).

## 1. URL map

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Shop home: what the shop is, link to the gallery. (No catalog of all pictures at launch; visitors arrive from art.) |
| GET | `/p/:uid` | **Picture page**: the painting, its products with previews, selection form. |
| POST | `/p/:uid/cart` | Set the selection (SKU → quantity) for this picture; redirect to `/cart`. |
| GET | `/cart` | The selection, editable; address form. |
| POST | `/cart/address` | Validate the address, request a quote; redirect to `/quote`. |
| GET | `/quote` | Itemised quote: items, shipping options, tax note, total; **Pay** button. |
| POST | `/checkout` | Create the order and the Stripe Checkout Session; `303` to Stripe. |
| GET | `/order/:id?t=<token>` | **Order status page** (private link): items, address (masked), status, tracking. |
| GET | `/checkout/cancelled?o=<id>&t=<token>` | Back from Stripe without paying: the cart is intact, try again. |
| GET | `/terms`, `/privacy`, `/shipping-returns`, `/contact` | Legal pages (texts are Klaus's). |
| GET | `/health` | `{status, version}` (cluster rule). |
| GET | `/api/offers` | Public JSON list of picture uids that have at least one ready offer; art reads it to decide where to show the link. |
| GET | `/files/:sha256.jpg` | Print files for Printful (unguessable, immutable; [04 §5](04-catalog-and-print-files.md#5-print-files)). |
| GET | `/static/*`, `/mockups/*` | CSS, icon, mockup images (cacheable). |
| POST | `/webhooks/stripe`, `/webhooks/printful` | Provider webhooks ([05 §4](05-quote-checkout-payment.md#4-payment-webhooks), [06 §5](06-fulfilment.md#5-status-and-tracking)). |
| GET/POST | `/admin/*`, `/auth/google/*` | Admin ([08](08-admin.md)). |

## 2. From art to the shop

- art adds, next to each painting (in the room's label and on the painting's page), a link **"Prints & merchandise"** to `https://shop.klaushofrichter.net/p/<uid>`. It is visibly distinct from art's **"Buy the original"** (`/buy/<room>/<slug>`), which stays as it is.
- art shows the link only for paintings the shop offers. art learns that from the shop's public `GET /api/offers` (a list of uids, cached by art for 10 minutes), so a painting Klaus hasn't enabled never shows a dead link. *(Alternative for the review: art always shows the link and the shop answers "not available yet". Simpler, but a visible dead end.)*
- No token, cookie or session crosses from art to the shop: the uid is the whole hand-off (ADR-0009).

## 3. Picture page

`GET /p/:uid`:

1. Look up the uid in the cached manifest (refreshed every 10 minutes and on admin request). Unknown uid → 404 page with a link to the gallery. Known but not enabled → a page "Prints of *Title* aren't available yet" with a link back to the painting on art (`?id=<uid>`).
2. Render:
   - The painting (art's public derivative, 1024/1536/2048 px `srcset`, with width and height so nothing jumps), title, year, medium, the physical size, a line: "Reproductions of the original painting. The original is shown in the gallery" with the link back; if the original is for sale, "The original is available" linking to art's `/buy/...`.
   - The offered products as cards: mockup image (the painting on the product), name, variant label ("8 × 10 in", "Black frame", "Size M"), price, a quantity field (0–10). Products whose print file is not ready are not shown (ADR-0019).
   - **Continue** (disabled until at least one quantity > 0 when JS is on; validated server-side either way).
3. The selection is stored server-side in a **cart** row keyed by a random cookie `shop_cart` (HttpOnly, Secure, SameSite=Lax, 30 days). A cart holds one picture (R2): choosing products of a different picture replaces the cart after a confirmation ("Your cart has products of *Other title*. Replace them?").

## 4. Cart and address

`GET /cart`: the items (quantity editable, remove), subtotal, and the address form:

| Field | Rules |
|---|---|
| Full name | required, 1–100 chars |
| Email | required, valid syntax; used for Stripe's receipt and (optional) shop emails |
| Address line 1, line 2 | line 1 required |
| City | required |
| State | required for US (select of US states + DC); required for CA, AU when those countries are enabled |
| ZIP / postal code | required; US: 5 or 9 digits |
| Country | select of enabled countries (US only at launch, ADR-0011) |
| Phone | optional (Printful passes it to carriers) |

Validation is server-side; errors re-render the form with messages tied to fields
(`aria-describedby`). No address autocomplete service at launch (privacy, cost).

## 5. Quote

`POST /cart/address` stores the address on the cart, asks the fulfilment provider for
shipping rates for these items to this address ([05 §2](05-quote-checkout-payment.md#2-quote)),
and stores a **quote** (valid 30 minutes). `GET /quote` shows:

```
Undertow — Klaus Hofrichter
  Framed print 8 × 10 in, black frame      1 × $59.00    $59.00
  Postcard 4 × 6 in                        4 × $4.00     $16.00
Shipping: ( ) Standard, 4–7 business days  $8.49
          ( ) Express, 2–3 business days   $21.80
Tax       calculated on the payment page (if Stripe Tax is on) / none
Total     $83.49
Ship to   Jane Doe, 1 Main St, Austin, TX 78701, US   [change]
[ Pay with Stripe ]          Terms of sale · Shipping & returns
```

- Shipping options are Printful's (`STANDARD` first; at most 3 shown).
- If Printful returns no rate (e.g. an item can't ship there), the page says so and offers to change the address.
- If the quote expired, **Pay** re-quotes first and shows the page again if anything changed.

## 6. Payment

`POST /checkout` (CSRF-protected):

1. Re-validate cart, address and quote (not expired; prices still current; every item still offered with a ready print file).
2. Create the **order** (state `checkout_open`) with items, prices, address and the chosen shipping as frozen copies.
3. Create the Stripe Customer and Checkout Session ([05 §3](05-quote-checkout-payment.md#3-checkout-session)), store the session id, `303` to the session URL.

On Stripe the customer sees the items, shipping, (tax) and total, enters card data
(or Apple Pay / Google Pay / Link) and pays. Stripe returns to:

- **success_url** `/order/<id>?t=<token>&from=checkout`: the status page. It shows "Payment received, preparing your order" as soon as the webhook has arrived; if it hasn't yet, "Confirming your payment…" and the page re-fetches the Checkout Session itself (by its id on the order) so the customer never sees a wrong state. The cart is cleared.
- **cancel_url** `/checkout/cancelled?o=<id>&t=<token>`: the order is marked `abandoned` (its Checkout Session expired via the API), the cart is untouched, **Pay** again creates a new order.

## 7. Order status page

`GET /order/:id?t=<token>`: the token is 128 random bits stored hashed; a wrong or
missing token gives 404 (not 403, to not confirm the id exists). Shows:

- Order number (`S-2026-000123`), date, picture, items, totals as paid.
- Ship-to: name and city/state/country only (address lines masked).
- A timeline in customer words: *Payment received → In production → Shipped (carrier, tracking link) → Delivered*; exceptions as *Delayed — we're on it* or *Refunded*.
- Contact link.

The link is shown after payment and in every email. `noindex`, `Cache-Control: no-store`.

## 8. Errors the customer can see

| Situation | Customer sees |
|---|---|
| Printful unavailable when quoting | "We can't calculate shipping right now. Please try again in a few minutes." (Retry button.) No order is created. |
| Stripe unavailable at **Pay** | Same kind of message; no order remains open (it is marked `abandoned`). |
| Payment declined | Stripe handles it on its page. |
| Paid, Printful order fails | Status page: "Delayed — we're on it". The system retries; after the limit it refunds automatically ([06 §7](06-fulfilment.md#7-failure-handling)) and the page says "Refunded". |
| Product no longer available between quote and pay | Re-quote page with a notice; the item is removed. |
| Order above the hard limits (quantity, items, total) | The form says so and offers the contact address for larger orders (ADR-0020). |
| Paid order held for approval | Status page: "Payment received — we're preparing your order" (no difference shown to the customer; if refunded after 72 h, "Refunded" and an email if enabled). |

## 9. Accessibility and quality

The cluster's public-pages baseline applies to every public page: four browsers,
axe-core with zero WCAG 2.2 AA violations, Lighthouse floors (90/100/100/100),
no layout shift, nothing scrolls sideways on a phone, text compressed. The quantity
fields are native `<input type=number>` with labels; the shipping choice is a
`<fieldset>` of radios; errors are announced (`role=alert` summary at the top).
