# Learnings from open-source print-on-demand projects

Research 2026-11-24, read-only clones, nothing run. Projects: dworznik/pressline (MIT, Printful v2 + Stripe Checkout, read at commit `ae54b44`), notrab/headless-dropshipping-starter (no license: ideas only), kerkkoh/simple-clothing-store (MIT), olivermrbl/medusa-printful, fsyntax/medusa-plugin-printful, legenki/print2medusa (MIT, Medusa v2, active), DavidAJohn/PhotoPortfolio (Stripe Checkout + Prodigi), kylemcdonald/prodigi-sizing, starkyru/prodigi-print-api, ekkolon/gelato-admin-node (Apache-2.0).

What changed in our design because of this is listed in [§6](#6-what-this-changes-in-our-design).

## 1. Order correctness

**One id everywhere.** Create our order row before the Stripe Checkout Session; the same id is Stripe's `client_reference_id` and metadata (on the session *and* the payment intent) and Printful's `external_id`. (Pressline ADR-0009.)

**Printful `external_id` rules** (Pressline `printful.ts:294-349`, print2medusa `order-idempotency.ts`): at most 32 characters `[A-Za-z0-9_-]`; Printful **never releases** an id, even for canceled orders, so a resubmission after a cancel needs a suffix (`<id>-2`). Never truncate silently.

**Submit sequence** (Pressline `submit.ts:132-276`):
1. `GET /v2/orders/@<external_id>`: if the order exists, record it (recovers from a crash between create and our write). The `@` lookup is undocumented but verified live by Pressline.
2. Create the draft; store Printful's order id at once.
3. Wait for Printful's cost calculation (drafts are priced asynchronously; confirming while `calculating` is refused with a 400 that is retryable).
4. **Cost guard**: confirm only if the amount Stripe charged covers Printful's total within our margin floor; otherwise `needs_attention` (notrab's amount check; Pressline only logs the delta, which they list as a gap).
5. Confirm.

**Claim before calling Printful** (print2medusa): a unique row "submitting order X" before the HTTP call, so two workers can't both create. Classify failures as `not_created` (safe to retry) or `unknown` (timeouts, 5xx, 429, 409: look the order up before retrying).

**Optimistic transitions, no locks** (Pressline `orders.ts:492-577`): `UPDATE orders SET state = :to WHERE id = :id AND state = :from` together with the insert into `order_transitions` in one transaction; the loser writes nothing. Every transition records `from, to, cause (storefront | stripe_webhook | printful_webhook | admin | reconciliation), cause_ref (event id), note, at`. Same-state facts (a dispute opened, a partial refund) are annotations: rows with `from == to`.

**Skip-forward edges.** Webhooks get lost, so the state machine allows e.g. `submitted → shipped` or `submitted → fulfilled` when polling finds a later state.

**Printful status mapping**: pending/inreview → submitted; onhold → on_hold; inprocess → in_production; partial → partly shipped; fulfilled → fulfilled; canceled → canceled; `failed` → submit_failed before confirmation, on_hold with a note after it.

**Cancel**: v2 `DELETE /v2/orders/{id}` only deletes drafts/archives; cancelling a pending order needs **v1** `DELETE /orders/{id}` (Pressline `printful.ts:744-761`). For an order still in Checkout, expire the Stripe session first so the customer can't pay.

**Partial shipments** (print2medusa): Printful splits orders across facilities; record one **shipment row per parcel** with its items and tracking. A cart makes this a real case for us (Pressline has single-item orders and can skip it).

**Shipping method fidelity** (print2medusa spec 2026-08-02): send the shipping method the customer paid for explicitly in the order; otherwise Printful picks one.

## 2. Webhooks and reconciliation

**Inbound-event ledger** (Pressline `inbound.ts:23-98`): `INSERT OR IGNORE` on `(provider, event_id)`, then claim with a 60 s lease; a duplicate returns the stored outcome; a crash lets the lease lapse and reconciliation replays. Printful events have no id: derive `sha256(type|occurred_at|order.id|shipment.id)[:32]`.

**Webhooks are hints**: verify, then re-fetch the object (Stripe session, Printful order) and act on what the API says.

**Acknowledge fast, work later**: Pressline submits inside the Stripe webhook (up to 20 s). We write the event and a job row, return 200, and let the job runner do the Printful work.

**Printful v2 signature** (Pressline code and tests, not yet confirmed against Printful's docs): headers `x-pf-webhook-signature` (hex) and `x-pf-webhook-public-key`; HMAC-SHA256 over the raw body with the **hex-decoded** `secret_key` returned once when the webhook config is created; constant-time compare; reject a different public key; accept `occurred_at` within 24 h. Printful retries at 1, 4, 16, 64, 256, 1024 minutes. Only one webhook config per token; registering replaces it. (Printful v1 webhooks are unsigned: print2medusa puts a secret in the URL path.)

**Events to subscribe**
- Stripe: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed` (Pressline misses this one and leaves orders stuck), `checkout.session.expired`, `charge.refunded`, `charge.dispute.created` / `charge.dispute.closed`.
- Printful: `order_created`, `order_updated`, `order_failed`, `order_canceled`, `order_put_hold`, `order_put_hold_approval`, `order_remove_hold`, `order_refunded`, `shipment_sent`, `shipment_delivered`, `shipment_returned`, `shipment_canceled`, `catalog_stock_updated`, `catalog_price_changed`.

**Registration is a deliberate step**: a script registers both webhooks after deploy and reports the secrets' location; `/health` (or an admin page) shows whether each is registered.

**Reconciliation** (Pressline `run.ts`, nightly there; **hourly** for us): stale checkouts (settle if Stripe says paid, else expire); paid but not submitted for 15 min → resubmit, alarm if stuck; catch up open Printful orders; refunds and disputes in the last 90 days; replay unsettled events; retry emails (cap 5); catalog availability. Persist each run's report; email Klaus only when there are alarms. Back off when Printful's `X-Ratelimit-Remaining` is low.

## 3. Print files and catalog

- **Print file before payment** (Pressline ADR-0004): "we took your money and the file was bad" is the worst failure. A product can only be offered once its print file exists and validated.
- **Immutable, content-addressed URLs** (Pressline ADR-0003): Printful re-fetches print files for reprints and caches by URL, so a URL must never expire or change content. Our earlier plan of 7-day signed URLs was wrong.
- **Validation** (Pressline `validate.ts`): exact pixel size for the placement (print area × DPI from `/v2/catalog-products/{id}/mockup-styles`), 8-bit, no CMYK or grayscale ICC, no alpha for paper/sublimation, under 200 MB. A 213 MB file was **silently not attached** in their live test. Printful silently upscales low-DPI files, so our DPI check has to be ours.
- **Colour**: convert to **sRGB** with a soft proof; camera JPEGs may be Adobe RGB and print washed out otherwise.
- **Crop/fit per size** (kylemcdonald/prodigi-sizing `geometry.js`, `resolutions.js`): fit the painting into each paper size, rank sizes by how even the borders are, show effective PPI, use the provider's pixel targets per size instead of a blanket 300 DPI.
- **Map to catalog variant ids**, never to Printful "sync products" (Pressline ADR-0006).
- **Availability**: hide variants that are `out_of_stock`, `temporary_out_of_stock` or `discontinued`; hide a product when none is available; treat unknown statuses as available (print2medusa `storefront-availability.md`).
- **Past orders keep rendering** after a variant is discontinued: store the product name, variant label and price on the order item.

## 4. Pricing, checkout, customers

- **Server-side pricing only**: the browser sends variant and quantity, never a price (notrab `pricing.ts`).
- **Quote lifetime**: a shipping quote is valid 30 min; a Checkout Session expires after 1 h (Pressline).
- **Checkout options** seen: `consent_collection.terms_of_service: required` with a ToS URL in the Stripe Dashboard; `allow_promotion_codes`; a delivery estimate on the shipping option; `phone_number_collection` (Printful passes the phone to carriers). Pressline turns Stripe's receipt email off to avoid duplicates with its own confirmation; we can keep one or the other.
- **Customer order page** gated by a per-order random token (128 bit), address masked (Pressline `public.ts`); no accounts.
- **Approval gate** (PhotoPortfolio `ShouldApproveOrder`): auto-approve orders below an amount, hold larger ones for the admin: a cheap fraud guard for expensive framed prints.
- **Order economics**: cost, fees and margin per order, and an alert when Printful's prices change (print2medusa).

## 5. Operations and testing

- **Config validated at boot**, secrets optional so the app starts and `/health` reports what is missing (Pressline `runtime.ts`).
- **PII purge**: null names and addresses on terminal orders after N days, keep country and totals; **also redact stored raw webhook payloads** (Pressline forgets these).
- **Tests**: boot the real app with in-memory fakes for Printful, Stripe and email plus a controllable clock (Pressline `tests/harness.ts`); adapter contract tests against **recorded fixtures** refreshed by a script; assert only what callers can observe. Their audit: the first live order found four bugs no test could have caught, so a real order (and a sandbox one) is part of going live.
- **Demo mode**: create the Printful draft and cancel it at once; refuse live Stripe keys.
- **Keep docs and code in sync**: Pressline's docs and code disagree on timings and events, which caused one of their bugs.

### Prodigi and Gelato

From review sites (several written by the vendors) and open-source clients; directional only.

- **Prodigi**: most recommended for archival giclée, papers such as Hahnemühle, rich framing (frame colours, mounts, glazing), a **sandbox environment**, idempotency keys, quotes. Weaker tooling and branding; no catalog-listing endpoint; callbacks are unsigned (re-fetch on every callback).
- **Gelato**: most local production (fastest shipping), draft orders like Printful, framing more basic than Prodigi's.
- **Printful**: best API and tooling, strong for mugs, t-shirts and postcards; few fine-art papers and basic framing.

→ [ADR-0017](../adr/0017-fulfilment-provider-interface.md).

## 6. What this changes in our design

| Change | Where |
|---|---|
| Print-file URLs are immutable and content-addressed, not 7-day signed URLs; print files exist and validate before a product can be sold | ADR-0006 (amended), [ADR-0019](../adr/0019-print-files-before-sale.md), design §7 |
| A fulfilment-provider interface; evaluate Prodigi for framed prints with sample orders | [ADR-0017](../adr/0017-fulfilment-provider-interface.md) |
| Order ledger: transitions with cause, inbound-event ledger, claim before submit, cost guard, hourly reconciliation, shipments per parcel, v1 for cancel | [ADR-0018](../adr/0018-order-ledger-and-reconciliation.md), design §6 |
| Hold orders above an amount for approval | [ADR-0020](../adr/0020-approval-hold-above-amount.md) |
| Launch scope vs later features | [ADR-0021](../adr/0021-launch-scope.md) and §7 below |

## 7. Feature tiers

**Launch**
- Server-side prices; amount/cost check before confirming at Printful.
- Event ledger and idempotent submit; Printful and Stripe webhooks including disputes and failed async payments; hourly reconciliation.
- Order status page by link (token), order confirmation and shipping emails.
- Mockups from Printful's generator (pre-generated in the admin), and the real painting photos from art.
- Crop/fit per size with a preview, DPI check, sRGB conversion.
- Frame colour as a variant of the framed print.
- Stripe promotion codes (one flag in Checkout).
- Stripe Tax per ADR-0012; Stripe Radar (on by default).
- Availability sync (hide out-of-stock variants), price-change alert.
- SEO: OpenGraph image per picture, Product structured data, sitemap.
- Accessibility per the public-pages baseline.
- Rate limiting on quote and checkout endpoints.
- Order export (CSV) for accounting.
- Sample orders of every product before launch.

**Within a year**
- Limited or numbered editions (our own counter).
- Gift message and branded packing slip.
- Prices in other currencies.
- Second provider (Prodigi) for fine-art and framed prints.
- Newsletter for new paintings.
- Abandoned-checkout email (only with consent).
- Admin bulk actions; order economics dashboard.
- Watermarked or reduced previews.

**Nice to have**
- Back-in-stock alerts, wishlist, reviews, social share buttons, customer accounts, gift wrap, room preview of framed prints, exchanges as their own objects.
