# 3. Customer journey

Revised for review round 2 (2026-11-25): a cart with any pictures (ADR-0026), routes per
source (ADR-0035), "find my order", the status token exchanged for a cookie, a
side-effect-free cancel return, a preview gate before go-live. Round 2 fold-in
(2026-11-26): the gate is its own switch and spares the files Printful and Stripe fetch;
the cart empties on payment.

All pages are server-rendered HTML with a little progressive-enhancement JavaScript;
every page works without JavaScript; forms POST and redirect. **All public forms carry a
CSRF token** (review 1 F28).

## 1. URL map

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Shop home: what the shop is, links to the galleries, the cart. |
| GET | `/p/:source/:work` | **Picture page** (canonical). |
| GET | `/p/:work` | Alias for the default source (art's link, ADR-0009). |
| POST | `/cart/items` | Add or change items (work, SKU, quantity); redirect to the cart or back to the picture. |
| GET | `/cart` | The cart: items grouped by picture, editable; address form. |
| POST | `/cart/address` | Validate the address, quote; redirect to `/quote`. |
| GET | `/quote` | Itemised quote and **Pay**. |
| POST | `/checkout` | One open checkout per cart; `303` to Stripe ([05 §3](05-quote-checkout-payment.md#3-checkout-session)). |
| GET | `/order/:id?t=…` | First visit: token → cookie, redirect to `/order/:id`. |
| GET | `/order/:id` | **Order status page** (with the cookie). |
| GET, POST | `/order/find` | **Find my order**: order number + e-mail → the link is e-mailed. |
| GET | `/terms`, `/privacy`, `/shipping-returns`, `/contact` | Legal pages (Klaus's texts). |
| GET | `/health` | `{status, version}`. |
| GET | `/health/worker` | 200 while the job runner and alerts work, else 503 ([11 §4](11-operations.md#4-observability)). |
| GET | `/api/offers?source=…` | Work ids with a sellable offer (art reads it to show its link). Empty while the preview gate is on. |
| GET | `/img/*`, `/mockups/*`, `/static/*`, `/files/*` | Display images, mockups, CSS and icon, print files. |
| POST | `/webhooks/stripe`, `/webhooks/printful` | Provider webhooks (not behind the preview gate). |
| GET/POST | `/admin/*`, `/auth/google/*` | Admin ([08](08-admin.md)). |

## 2. From a gallery to the shop

- art shows **"Prints & merchandise"** next to a work only if `GET shop…/api/offers?source=art` lists it (cached by art for 10 minutes), linking to `https://shop.klaushofrichter.net/p/<uid>`. Distinct from art's "Buy the original".
- No token or session crosses from the gallery: the work id is the whole hand-off.

## 3. Picture page

`GET /p/:source/:work`:
1. Look the work up. Unknown → 404 with links to the galleries. Known but nothing sellable → "Prints of *Title* aren't available" with a link back to the work on its source.
2. Show the work (the shop's display image, `srcset`, width and height set), title, creator, year, and wording from its `kind` ("Prints of the painting …" / "of the photograph …"); never claims about originals the source didn't make.
3. The sellable offers as cards: mockup, name ("Art print 12 × 16 in, landscape"), price, a quantity field whose `max` is the SKU's limit from `SKU_MAX_QUANTITY`; **Add to cart**.
4. A visible cart link with the item count on every page.

## 4. Cart and address

`GET /cart`: items grouped by picture (thumbnail, product, quantity, line total, remove);
subtotal; the address form. Mixed carts note "Paper prints and apparel may arrive in
separate parcels."

| Field | Rules |
|---|---|
| Full name | required, 1–100 characters, Latin script |
| E-mail | required; used for Stripe's receipt and the shop's e-mails (ADR-0027) |
| Address line 1, line 2 | line 1 required |
| City | required |
| State | required (US states and DC) |
| ZIP | required, 5 or 9 digits; checked against the state locally ([05 §2](05-quote-checkout-payment.md#2-quote)) |
| Country | US (ADR-0011) |

No phone field (ADR-0031). Errors re-render the form with messages tied to fields and a
`role=alert` summary.

## 5. Quote

```
Undertow — Klaus Hofrichter
  Framed print 12 × 16 in, black frame, landscape   1 × $79.00    $79.00
Sunday Market — Klaus Hofrichter
  Postcard 4 × 6 in                                  4 × $4.00     $16.00
Shipping: ( ) Standard, 4–7 business days                          $9.49
          ( ) Express, 2–3 business days                           $22.80
Sales tax, if any, is calculated on the payment page
Total before tax                                                  $104.49
Ship to   Jane Doe, 1 Main St, Austin, TX 78701, US   [change]
[ Pay with Stripe ]                   Terms of sale · Shipping & returns
```

(Prices are placeholders.) A quote is valid 30 minutes; **Pay** after expiry re-quotes
and shows the page again if anything changed. If the pre-payment cost check fails, Pay is
replaced by "This combination can't be ordered right now" ([05 §2](05-quote-checkout-payment.md#2-quote)).

## 6. Payment

`POST /checkout` → Stripe's hosted page, which shows the items, shipping, tax, total, and
"Ships to …" above the pay button. Returns:
- **success_url** → the status page (§7). The cart is emptied when the payment is recorded, so a later visit starts with an empty cart.
- **cancel_url** → the cart, unchanged. Nothing is closed by this return ([05 §5](05-quote-checkout-payment.md#5-return-from-stripe)).

## 7. Order status page

- The link in e-mails and on the success page carries the token once: `/order/:id?t=…` sets an HttpOnly, Secure, SameSite=Lax cookie scoped to `/order/:id` and redirects to the clean URL (review 1 F18). The shop's logs never record query strings. Wrong or missing token → 404.
- Shows: order number, date, items by picture, totals as paid, ship-to (name, city, state only), the derived status ([07 §2.6](07-orders-data-jobs.md#26-customer-facing-status-derived)) and a **per-parcel** block (contents, carrier, tracking link, estimated delivery).
- While "confirming your payment" it refreshes itself (meta refresh, every 5 s, up to 2 minutes).
- `noindex`, `Cache-Control: no-store`.

## 8. Find my order

`/order/find`: order number + e-mail → if they match, the status link is **e-mailed** to
that address (never shown). The page gives the same answer whether or not an order
matched. Rate-limited per client address and per order number.

## 9. Before go-live

In `mock` and `test` mode (ADR-0029, review 1 F24): a banner on every public page ("Test
shop — nothing is charged or shipped"), `noindex` everywhere, and customer e-mails only to
an allow-list.

The **preview gate** is its own switch (`PREVIEW_GATE`), on in mock and test mode and
**also in live mode until Klaus's own first orders have arrived** (review C F5). While it
is on, `/api/offers` is empty (art shows no link) and every page asks for a shared
preview key (set as a cookie) or an admin session, except `/health*`, `/webhooks/*`,
`/auth/*`, and `/files/*`, `/img/*`, `/mockups/*`, which Printful and Stripe fetch
without a cookie (review B F2; those URLs are unguessable hashes).

## 10. Errors the customer can see

| Situation | Customer sees |
|---|---|
| Printful unavailable when quoting | "We can't calculate shipping right now; please try again in a few minutes." No order. |
| Stripe unavailable at Pay | "Payment is unavailable right now." No payable session remains. |
| Address rejected by Stripe Tax | the address form with the message |
| Above the hard limits | the cart says so and offers the contact address |
| Paid, order held or delayed | status page: "Payment received — we're checking your order"; a "delayed" e-mail after the configured time |
| Paid, then refunded automatically | status page and e-mail: "Refunded — we couldn't produce this order" |

## 11. Accessibility and quality

The cluster's public-pages baseline: four browsers, axe-core (WCAG 2.2 AA), Lighthouse
floors (90/100/100/100), no layout shift, no sideways scroll, compressed text. Quantity
fields are labelled native number inputs; the shipping choice is a fieldset of radios.
