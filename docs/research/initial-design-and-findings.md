# Initial design and findings (superseded)

> Superseded on 2026-11-24 by the design set in [docs/design/](../design/README.md). Kept for its research findings (§2) and history. Links below are relative to the former location `docs/design.md`.

Status: draft for Klaus's review, 2026-11-24. No service code exists yet.
Every decision here is an ADR in [docs/adr](adr/README.md). Proposed ones wait for Klaus's decision.

## 1. Goal

A self-served order pipeline for prints and merchandise made from the pictures on https://art.klaushofrichter.net, served at https://shop.klaushofrichter.net:

- A visitor picks a picture on art and continues into the shop with that picture.
- They choose from a predefined set of products for that picture: initially a postcard, a framed print, a mug and a t-shirt, in various sizes.
- An admin area (Google sign-in, Klaus only) defines the SKUs (restricted to what Printful supports), which products each picture offers, and the prices.
- After that, everything is automatic: payment, order placement with Printful, confirmation, shipping updates.

Not in scope: selling the originals. art already has a purchase page for originals at `/buy/<room>/<slug>`; the shop sells reproductions only and says so ([§4](#4-from-art-to-the-shop)).

## 2. Findings from the research

Sources: Printful's v1 and v2 API docs and help center, Stripe's docs and pricing. During the first pass this container's network blocked printful.com and stripe.com, so most findings came from search summaries of the official pages, Printful's v2 OpenAPI spec (as packaged in an npm SDK) and SDK code. Klaus allowed both domains on 2026-11-24; since then the product ids were checked against Printful's live catalog and Stripe's shipping limitation against its docs. Items still marked *(verify)* must be checked before code depends on them (several need Klaus's Printful token: the v2 catalog requires authentication).

### Printful

- **API version.** v2 (`https://api.printful.com/v2/...`) is still labelled beta (announced 2023-09). v1 keeps working with no announced sunset date. v2 has what we need and v1 lacks: catalog prices and availability per region, print-area sizes and DPI per placement, explicit draft → confirm orders, signed webhooks. → [ADR-0005](adr/0005-printful-api-v2.md)
- **Auth.** A private token, store-level, with chosen scopes (`orders`, `file_library`, `webhooks`, and the read variants). Tokens expire and are rotated by hand. No OAuth app needed for one store. Klaus created the token 2026-11-24 (`PRINTFUL_TOKEN` in the shop's `.env` on the node).
- **Catalog.** `GET /v2/catalog-products`, `/catalog-variants`, `/prices`, `/availability`, `/mockup-styles` (print-area pixels and DPI per placement), `/shipping-countries`. Product ids, checked against the live v1 catalog 2026-11-24: Enhanced Matte Paper Poster (in) **1** (33 variants, 10×10 to 24×36), Enhanced Matte Paper Framed Poster (in) **2** (39 variants: 8×10, 11×14, 12×16, 16×20, 18×24, 24×36 and more, in several frame colors), White Glossy Mug **19** (11, 15, 20 oz), Standard Postcard **433** (4×6, one variant), Unisex Staple T-Shirt Bella+Canvas 3001 **71** (628 variants, XS–5XL, many colors), Unisex Basic Softstyle T-Shirt Gildan 64000 **12** (249 variants).
- **Print files.** PNG or JPG, at most about 100–200 MB and 20,000 px per side. Paper products want 300 DPI, apparel 150 DPI. Printful fetches files by URL (in the order item, or registered once in the file library). A 16×20 print at 300 DPI is 4800×6000 px.
- **Measured with Klaus's token, 2026-11-24** (`scripts/printful-probe.sh`, run read-only on the node by Cluster; all 21 requests 200):
  - The token is store-level for one native (API) store; scopes `orders`, `sync_products`, `file_library`, `webhooks` and their read variants. Catalog reads work with it. No webhooks are configured yet.
  - Print areas and wholesale prices (North America, USD, from):

    | Product | Print area | DPI | From |
    |---|---|---|---|
    | Poster (1), digital | the paper size: 12×16, 12×18, 16×20, 18×24, 24×36 in (portrait or landscape) | 300 | $11.75 / $13.75 / $18.95 … |
    | Framed poster (2), digital | the same sizes | 300 | $32.20 / $46.30 / $75.90 … |
    | Mug (19), sublimation | wrap 9 × 3.5 in (11 oz); 15 and 20 oz have their own areas (up to 10.24 × 4.02 in) | 300 | $6.95 / $8.50 / $9.69 |
    | Postcard (433), digital | 6.14 × 4.13 in (4×6 with bleed) | 300 | $1.53 |
    | T-shirt Bella+Canvas 3001 (71) | DTG front or back 12 × 16 in; sleeves 4 × 3.5; embroidery 4 × 4 at 300 DPI; DTF also offered | 150 | $11.95 (DTG) |
    | T-shirt Gildan 64000 (12) | the same placements | 150 | $9.63 (DTG) |

  - The v2 prices response listed 20 variants (its default page size); the full lists come from the public v1 catalog, whose variant ids match v2's. **Posters**: 33 sizes from 5×7 to 30×40 in, including 8×10, 11×14, 16×20, squares and A-sizes. **Framed posters**: 13 sizes × 3 frame colours (black, white, red oak): 8×10 $20.76, 10×10, 12×12, 11×14 $30.69, 12×16 $32.20, 12×18, 14×14, 16×16, 16×20 $42.61, 18×18, 18×24 $46.30, 20×30 $56.18, 24×36 $75.90 (v1 prices; the frame colour does not change the price).
  - v2's North-America poster prices are about $0.60–0.70 above v1's list (e.g. 12×16: $11.75 vs $11.11); framed prices match. The shop uses v2 prices.
  - Many paintings on art are 10 × 8 in (4:5). Sizes with the same ratio are 8×10 and 16×20; other sizes need a crop or a border (§7).
  - Printful gives volume discounts per order (e.g. postcards 30% from 25 items, framed posters 5% from 25): irrelevant for single orders, useful for Klaus's own bulk orders.
  - At 300 DPI a 16×20 print needs 4800 × 6000 px and a 24×36 print 7200 × 10800 px; at the 150 DPI floor proposed in §7, 2400 × 3000 and 3600 × 5400. The postcard needs about 1840 × 1240 px, the 11 oz mug wrap 2700 × 1050 px, the t-shirt front 1800 × 2400 px.
  - **What decides the largest sizes** is the pixel size of the painting photos on art's volume, still unmeasured (open item in §14).
- **Mockups.** An async task API with a hard limit of 2–10 task creations per minute per store. Mockups must be generated ahead of time in the admin and cached by the shop, never per visitor.
- **Orders.** `POST /v2/orders` always creates a draft; `POST /v2/orders/{id}/confirmation` submits it and only then is Klaus's Printful account charged. `external_id` makes order creation idempotent and lets us look orders up. Statuses: draft, failed, inreview, pending, onhold, inprocess (no longer cancellable), partial, fulfilled, canceled. Costs: `POST /v2/order-estimation-tasks` (async) and `POST /v2/shipping-rates`.
- **Webhooks.** One configuration per token; events include `shipment_sent`, `shipment_delivered`, `shipment_returned`, `order_failed`, `order_canceled`, `order_put_hold`, `order_refunded`. Signed with HMAC-SHA256 over the raw body *(verify the exact scheme)*. No documented retry policy, so we also poll.
- **No sandbox.** Draft orders are never charged or fulfilled. Testing = drafts that are never confirmed, or a second test store.
- **Rate limits.** About 120 requests per minute per store; `X-Ratelimit-*` headers and `Retry-After` on 429.
- **Billing.** Printful charges Klaus's Printful account the wholesale price + shipping + tax per confirmed order, from the Printful Wallet or a saved card. No monthly fee for an API store *(verify)*. Printful charges US sales tax on its wholesale price unless Klaus files a resale certificate, and EU VAT unless he has a VAT id.
- **Defects.** Reprint or refund (to the Printful Wallet) for misprints and damage reported within 30 days of delivery, with a photo. No change-of-mind returns.
- **Customer payment.** Printful offers no checkout or payment for custom API stores. We collect payment ourselves.

### Stripe

- **Checkout.** Hosted Checkout fits a server-rendered shop: the server creates a Checkout Session with ad-hoc `price_data` line items (no product catalog in Stripe), `client_reference_id` = our order id, and redirects. Card data never touches the shop (PCI SAQ A).
- **Shipping.** Hosted Checkout takes fixed `shipping_options`. Computing shipping after the customer enters the address inside Checkout ("dynamic shipping", `permissions.update_shipping_details`) works only with the embedded form or Elements; Stripe's docs (checked 2026-11-24): "The full embedded page and full hosted page don't support dynamically customizing shipping options". It also disables Apple Pay and Google Pay *(verify)*. → [ADR-0007](adr/0007-checkout-and-shipping-quote.md)
- **Webhooks.** `checkout.session.completed` (fulfil only if `payment_status = paid`), `checkout.session.async_payment_succeeded/failed`, `checkout.session.expired`, `charge.refunded`. Verify `Stripe-Signature` on the raw body. Live mode retries for 3 days; handlers must be idempotent (unique on event id).
- **Testing.** Sandboxes and test cards, `stripe listen` for local webhooks.
- **Stripe Tax.** `automatic_tax: {enabled: true}`. Collects only where Klaus has registered with the tax authority; 0.5% of volume through Checkout. → [ADR-0012](adr/0012-sales-tax-and-vat.md)
- **Refunds.** Full and partial via the API. Stripe keeps its original processing fee.
- **Fees.** 2.9% + 30¢ for US cards, +1.5% for international cards, +1% for currency conversion, no monthly fee.
- **Keys.** A restricted key (`rk_`): Checkout Sessions write, Refunds write, PaymentIntents/Charges/Events read, nothing else.
- **Merchant of record** (a reseller that handles tax for you): Stripe's own option and Paddle exclude physical goods; not an option for print-on-demand.

### Open-source projects

See [§12](#12-open-source-projects) and the deeper study in [research/oss-learnings.md](research/oss-learnings.md) (patterns, Prodigi/Gelato, feature tiers). Summary: none is a good base to adapt; we build a small service and borrow patterns. → [ADR-0003](adr/0003-build-not-adapt.md), [ADR-0017](adr/0017-fulfilment-provider-interface.md), [ADR-0021](adr/0021-launch-scope.md)

### art (measured 2026-11-24, with Cluster)

- art's manifest is embedded in its home page as `<script type="application/json" id="manifest">`: rooms (colors, dogs, food, about) with 25 works today. A work has `uid` (stable, used in permalinks `?id=<uid>`), `slug` (can change), `title`, `file` (the original's file name), `widths` of the public derivatives (up to 2560 px, plus webp), `v` (content hash), `date`, `artist`, `medium`, `dimensions` (the physical painting, e.g. "10 × 8 in"), and the original's `price` and `status`.
- Originals are camera JPEGs of the paintings on the PVC `art-assets-pvc` (namespace art, RWO, local-path, one node), mounted read-only into the art service; Retain and Velero-backed. Their pixel size is not in the manifest and is not yet measured.

## 3. Architecture

```
 visitor ──► art.klaushofrichter.net  (public gallery, no secrets)
               │  "Prints & merchandise" link: shop…/p/<uid>
               ▼
 visitor ──► shop.klaushofrichter.net  (this repo, one service)
               │  public pages, cart, checkout redirect, /admin (Google sign-in)
               │  SQLite on a Retain PVC ── Litestream ──► S3 (new bucket)
               ├──► Stripe Checkout (hosted) ◄── webhook /webhooks/stripe
               ├──► Printful API v2         ◄── webhook /webhooks/printful
               ├──► art, in-cluster only: GET /internal/originals/<uid> (bearer token)
               └──► email (order and shipping notices)
```

- **A separate service** in its own repo and namespace, not part of art. art stays a fast public gallery without secrets; the shop holds payment and order data and its own deploy cycle. → [ADR-0002](adr/0002-separate-shop-service.md)
- **Built here, not adapted** from an existing project. → [ADR-0003](adr/0003-build-not-adapt.md)
- **Stack**: Node 26, TypeScript, a small HTTP framework with server-rendered HTML (no SPA), SQLite through Node's built-in `node:sqlite` or better-sqlite3, `sharp` for print files. One process holds the web server and a job runner backed by a jobs table. One replica, because SQLite has one writer. → [ADR-0004](adr/0004-stack-and-runtime.md)
- **Runtime**: a plain Deployment (`replicas: 1`, `strategy: Recreate`, image pinned by digest), the cluster's shape for a single SQLite writer (cams-admin, games-cloud), with a Retain PVC, a Litestream sidecar, its own Ingress and Certificate, and Traefik's `compress-text` middleware. The runner may only get/watch/patch this one Deployment. Cluster writes the manifests in kube-setup.

## 4. From art to the shop

- art adds, on each work's page, a link **"Prints & merchandise"** to `https://shop.klaushofrichter.net/p/<uid>`, visually separate from its "Buy the original" button. That is art's only change besides the internal endpoint (§7). → [ADR-0009](adr/0009-art-to-shop-handoff.md)
- No session, token or state is carried across: the uid is enough. The shop reads art's public manifest (fetched from the home page, cached, refreshed every few minutes and on demand from the admin) for title, artist, date, description and the public derivative images used for previews.
- A uid the admin has not enabled for sale shows "Prints of this picture aren't available yet" with a link back to the picture on art.
- The shop page shows the picture, the title, "Prints and merchandise of *Title* by Klaus Hofrichter", the products offered for it, a link back to art, and, if the original is available, a line pointing to art's originals page. It has its own look but shares art's typography so the step feels continuous *(Klaus's call)*.
- Product page: product mockup images (pre-generated, §8), size/variant choice, price, "Add to cart".
- **Cart**: a small server-side cart keyed by a cookie, so a postcard and a mug share one shipment. A cart holds items from several pictures. → [ADR-0008](adr/0008-cart.md)

## 5. Checkout and payment

1. **Shipping address first, on the shop's page** (country, state, zip, street, name, email). The shop asks Printful for shipping rates (`/v2/shipping-rates`) and shows the shipping choices and the total (items + shipping; tax "calculated at payment" if Stripe Tax is on).
2. The shop creates the order in state `quoted` and a Stripe Checkout Session (hosted): one `price_data` line item per cart item, the chosen shipping as a fixed `shipping_options` entry, `shipping_address_collection.allowed_countries` = the quoted country, prefilled email, `client_reference_id` = order id, `metadata.order_id`, `automatic_tax` per ADR-0012, expiry 1 hour.
3. The customer pays on Stripe and returns to `/order/<id>?token=…`, which shows the status.
4. `checkout.session.completed` with `payment_status = paid` moves the order to `paid`. The shop compares the address entered in Checkout with the quoted one: if the country or state differs, the order goes to `needs_attention` instead of to Printful (the shipping price might be wrong).

Alternative: embedded Checkout with dynamic shipping (address entered once, inside Stripe's form; no Apple/Google Pay). → [ADR-0007](adr/0007-checkout-and-shipping-quote.md)

Currency: USD only to start. Shipping region: to be decided, recommended US + Canada + EU + UK. → [ADR-0011](adr/0011-currency-and-shipping-region.md)

## 6. Orders: states and automation

```
quoted ──► checkout_open ──► paid ──► files_ready ──► submitted ──► confirmed ──► in_production ──► shipped ──► delivered
              │                 │          │              │             │                              │
              ▼                 ▼          ▼              ▼             ▼                              ▼
           expired        needs_attention (any step that fails after payment) ──► resolved | refunded    returned
                                                 canceled (by Printful or admin) ──► refunded
```

| State | Meaning | Next step (automatic unless noted) |
|---|---|---|
| quoted | Address and shipping chosen, no payment yet | Checkout Session created → checkout_open |
| checkout_open | Customer is on Stripe | `checkout.session.completed` → paid; `expired` → expired |
| paid | Stripe confirmed payment | Generate/fetch print files → files_ready |
| files_ready | Print files exist and are reachable by Printful | Create Printful draft order (`external_id` = order id) → submitted |
| submitted | Printful draft exists, costs estimated | Confirm (live) → confirmed. In test mode: stop here. |
| confirmed | Printful accepted (pending), Klaus's Printful account charged | Printful webhooks / polling |
| in_production | Printful `inprocess` | — |
| shipped | `shipment_sent` (per shipment; partial possible) | Email the customer the tracking link |
| delivered | `shipment_delivered` | — |
| needs_attention | Something after payment failed | Email Klaus; admin: fix and retry, or refund |
| refunded | Full or partial Stripe refund issued | — |

- **Ledger and reconciliation** follow the patterns in [research/oss-learnings.md](research/oss-learnings.md): transitions recorded with their cause, an inbound-event ledger, claim before submit, `@external_id` lookup, v1 for cancel, shipments per parcel, hourly reconciliation. → [ADR-0018](adr/0018-order-ledger-and-reconciliation.md)
- **Approval hold**: paid orders above an amount wait for Klaus's approval. → [ADR-0020](adr/0020-approval-hold-above-amount.md)
- **Jobs.** Each transition after `paid` is a job in the jobs table, retried with backoff (1 min, 5 min, 30 min, 2 h). Every step is idempotent: print files keyed by (uid, variant, version); Printful orders by `external_id`; emails by (order, kind).
- **Polling.** Webhooks can be lost; a job polls Printful for every open order every 30 minutes and Stripe for sessions still open past their expiry.
- **Cost guard.** Before confirming, the shop compares Printful's estimated cost with what the customer paid. If the margin is below a floor the admin sets (e.g. negative), the order goes to `needs_attention` instead of being confirmed.
- **Failure policy** (payment fine, Printful fails): retry automatically for up to 24 h, then `needs_attention` and an email to Klaus. Proposal: if unresolved after 72 h, refund in full automatically and tell the customer. → [ADR-0010](adr/0010-order-failure-and-refunds.md)
- **Printful defects and returns**: Klaus reports them in Printful's dashboard (photo within 30 days); the shop records the outcome. Reprints arrive as new shipments of the same order.
- **Test mode.** `SHOP_MODE=test`: Stripe test keys, Printful draft orders that are never confirmed (or a separate Printful test store). Going live is Klaus's switch, a config change in his session.

## 7. Print files and the originals

- The originals stay private on art's volume. art adds an internal endpoint `GET /internal/originals/<uid>` that streams the original of a work. Requirements (agreed with Cluster):
  - A bearer token is mandatory (a Secret shared by art and shop, created by Cluster or Klaus).
  - art's public route sends every path to the service, so `/internal` must also be blocked on the public route (a Traefik rule), or art refuses it unless the request came in through the cluster-local host name. Both, preferably.
  - The shop calls `http://art.art.svc.cluster.local/internal/originals/<uid>`.
  → [ADR-0006](adr/0006-originals-access.md)
- Fallback/override: the admin can upload a print file for a picture (e.g. a better scan, or a pre-cropped file for one product).
- The shop renders one print file per (picture, Printful variant): crop or fit to the print area's aspect ratio as set in the admin, resize to the print area's pixels, sRGB JPG. Files are cached on the shop's volume.
- Printful fetches files by URL, also later for reprints, and caches by URL. The shop serves them at immutable, content-addressed, unguessable URLs `https://shop.klaushofrichter.net/files/<sha256>.jpg` that never expire; a new crop or source gives a new URL. A product is offered only after its print file was rendered and validated (exact pixels, 8-bit sRGB, under 200 MB, DPI floor). → [ADR-0019](adr/0019-print-files-before-sale.md)
- **Resolution check.** The admin shows each picture's effective DPI per product and refuses to offer a product below a threshold (proposed: 150 DPI for paper, 100 for apparel and mugs). The originals' pixel size is not yet known; a camera JPEG of 4000×3000 px gives 200 DPI at 20×15 in, so the largest framed sizes may need to be excluded per picture.

## 8. Admin

- Inside the shop at `/admin`, behind Google sign-in with the cluster's hand-rolled pattern (`google-auth-library`, `state` cookie, `ALLOWED_EMAILS`, HMAC-signed session cookie, logout that lands on a 200 page with a Sign in link, `Cache-Control: no-store`), its own OAuth client in the `skylar-technology` project; CSRF protection on admin forms. → [ADR-0013](adr/0013-admin-in-shop.md)
- **SKUs**: Klaus picks Printful catalog products and variants (e.g. framed poster 16×20 black frame, mug 11 oz, t-shirt M white). The list comes from Printful's catalog API, so only supported variants can be chosen. Each SKU stores Printful's product and variant ids, the placement, the print area (pixels, DPI) and a default retail price. A job refreshes Printful's prices and availability daily and flags SKUs that went out of stock or got more expensive.
- **Pictures**: from art's manifest. Per picture: enabled or not, which SKUs it offers, price overrides, crop/position per product (a simple crop box on the preview), the effective DPI per SKU, mockups.
- **Prices**: per SKU, with optional per-picture override. The admin shows Printful's cost (product + typical shipping), Stripe's fee and the margin next to each price.
- **Mockups**: "Generate mockups" queues Printful mockup tasks (respecting the 2–10 per minute limit) and stores the results on the shop's volume.
- **Orders**: list and detail with the full event history; actions: retry step, confirm manually, cancel, refund (full or partial), resend email.
- **Settings**: shipping countries, margin floor, notification address, test/live indicator (read-only; going live is a deploy-config change).

## 9. Data

SQLite on a Retain PVC, continuously replicated by Litestream to a new S3 bucket (hourly snapshots like cams-admin, continuous WAL shipping), plus a Velero file-system backup of a `VACUUM INTO` snapshot as a second line. Restore is tested before go-live. Klaus creates the bucket and IAM user (e.g. `klaushofrichter-k3s-shop-backups`). → [ADR-0014](adr/0014-data-store-and-backup.md)

Tables (first cut): `skus`, `pictures` (uid, enabled, crop settings), `picture_skus` (offered, price override), `print_files`, `mockups`, `carts`, `cart_items`, `orders` (state, amounts, Stripe and Printful ids, quoted address), `order_items`, `order_events` (append-only history: every state change, webhook and admin action), `jobs`, `webhook_events` (raw events, unique on provider+id), `emails`.

Personal data: name, email, shipping address, order contents. No card data. Retention proposal: order records kept 10 years (tax records), carts deleted after 30 days, quoted-but-unpaid orders after 90 days.

## 10. Notifications

- Payment receipt: Stripe's receipt email (turn on in Stripe), plus the shop's own order confirmation with a link to the order status page.
- Shipping: the shop emails the tracking link on `shipment_sent`. Printful does not email the end customer for API orders *(verify)*.
- Klaus: an email for every new paid order (optional) and for every `needs_attention`.
- Sending: needs an email provider. Options: Amazon SES (AWS is already in use), or an SMTP account Klaus has. → [ADR-0015](adr/0015-email-provider.md)

## 11. Legal pages, tax and costs

These are Klaus's decisions; the shop will host what he approves. Not legal or tax advice.

- **Pages**: terms of sale, privacy policy (Stripe and Printful as processors; the email provider; Google for admin sign-in only; cookies: cart and session only, no tracking), shipping and returns (mirrors Printful: misprints and damage reported within 30 days with a photo are reprinted or refunded; no change-of-mind returns, as every item is printed to order), contact/imprint.
- **Sales tax / VAT** → [ADR-0012](adr/0012-sales-tax-and-vat.md). Facts: Stripe Tax only collects where Klaus is registered; US states require registration once sales into a state pass an economic-nexus threshold (commonly $100,000 a year), and Klaus's home state from the first sale if it taxes these goods; EU VAT on goods shipped from outside the EU has its own rules (IOSS for consignments up to €150). Separately, Printful charges Klaus US sales tax on its wholesale price unless he files resale certificates, and EU VAT unless he has a VAT id.
- **Costs**: no monthly fees for Stripe or a Printful API store *(verify Printful)*. Per order: Printful wholesale + shipping (+ tax charged by Printful), Stripe 2.9% + 30¢ (+1.5% international, +1% conversion), Stripe Tax 0.5% if used. Fixed: S3 storage for backups (cents a month), email (SES: $0.10 per 1,000). The admin shows the margin per product so Klaus can price.

## 12. Open-source projects

Checked 2026-11-24 (commit dates from clones; nothing was run).

| Project | State | Printful | Payment | Verdict |
|---|---|---|---|---|
| dworznik/pressline (Lenskiy/pressline is a fork with one extra commit) | MIT, upstream active (2026-10-17) | v2 only | Stripe Checkout | Best reference: 17 ADRs, order state machine, reconciliation, tests. But one item per order, no cart, no catalog admin, SvelteKit + Effect. Learn from it, don't adapt. |
| neverjunior05/print-on-demand-store (THREADFORM) | MIT, 2 commits | none (mock fulfilment) | Stripe | Nothing to reuse for Printful. |
| BelialRunnerX/belialdigital | not public | — | — | — |
| lbsudo/printful-nextjs-starter | MIT, archived 2023 | v1 | Stripe, signature not verified | Avoid. |
| olivermrbl/medusa-printful | no license, 2022 | v1 | via Medusa v1 | Broken experiment. |
| kerkkoh/simple-clothing-store | MIT, 2026-05 | v1 | PayPal | Broke when Printful retired legacy Basic-auth store keys for Bearer tokens; still confirms the wrong order id. |
| notrab/headless-dropshipping-starter | no license, active | v1 | Stripe Payment Element | Good idea to copy (ideas only, no license): confirm the Printful draft only if the amount paid covers Printful's total. |

Patterns we take (→ [ADR-0003](adr/0003-build-not-adapt.md)): one order id through Stripe (`client_reference_id`, metadata) and Printful (`external_id`); every state transition recorded with its cause; submit = look up by `external_id`, create draft, confirm; honour `Retry-After`; webhooks are hints followed by a re-fetch; a reconciliation sweep that alarms on paid orders that are stuck; the amount check before confirming.

## 13. Delivery plan (after Klaus's decisions)

All of it follows the cluster's repository and deployment rules (→ [ADR-0016](adr/0016-follow-cluster-repository-rules.md)): calendar versions `YYYY.MM.DD.N` generated at deploy time, the three workflows, protected `production`, required checks `test`/`codeql`/`e2e`, Node 26, non-root image, the public-pages baseline.

1. Repo baseline: package.json (Node 26), `.gitignore` with `.env`, lint and unit tests, `production-checks.yml` with `npm audit --audit-level=high`, CodeQL, `build-push.yml`, `.github/dependabot.yml` (npm + github-actions, weekly Monday, labels `dependencies` and `ci`), README badge row, `CHANGELOG.md` with `## [Unreleased]`, Dockerfile (`ARG APP_VERSION=dev`, `USER 1000:1000`), `GET /health` with the version. Cluster: `production` branch protection, labels.
2. Skeleton service: health, art manifest reader, public picture/product pages with fake data, admin sign-in.
3. Printful catalog → SKU admin; pictures admin; print-file rendering; mockups.
4. Cart, shipping quote, Stripe Checkout in test mode, webhooks, order state machine and jobs, emails.
5. art: the "Prints & merchandise" link and the internal originals endpoint (in art's repo, with art's owner session).
6. Deploy (Cluster): namespace, PVC, Secrets, Litestream, ingress for shop.klaushofrichter.net once Klaus gives the go for the DNS name.
7. End-to-end test in test mode: Stripe test card → Printful draft. Then Klaus places one real order and goes live when he says so.

## 14. Open items to verify

- ~~Printful print-area sizes and DPI per product~~ (measured 2026-11-24, §2). Still open: the v2 webhook signature scheme, whether Printful emails customers for API orders, and its fee schedule. The network now allows Printful and Stripe; the v2 catalog needs a Printful token (Klaus has accounts with both services; he creates the tokens and puts them in the shop's `.env` on the node, from which a script creates the Kubernetes Secret, never printed).
- Stripe: the exact `ui_mode` names for the pinned API version, the tax codes for posters, apparel and mugs.
- art: the pixel size of the originals (decides the largest offered sizes); uid stability in art's tests (`e2e/helpers.ts`, `site.spec.ts`).
