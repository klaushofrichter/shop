# Design Review: `klaushofrichter/shop`

- **Date:** 2026-11-24
- **Target:** `klaushofrichter/shop` (`main` branch: `docs/design/01–14`, `docs/adr/0001–0025`, `docs/research/*`, `src/*`, `.github/workflows/*`, `scripts/*`)
- **Reference Source Checked:** `klaushofrichter/art` (`src/content.ts`, `src/urls.ts`, `src/routes/buy.ts`, `src/views/buy.ts`, fixture `index.json` files)
- **Secrets Check:** Clean. No secrets, tokens, or private keys were found in the repository.

---

## 1. Summary Verdict

**Verdict: Ready to implement after listed changes.**

The design is unusually rigorous for a low-volume shop. Grounding the design in real API captures (`docs/research/api-capture-findings.md`) before writing application code prevented several classic Stripe/Printful integration failures (account default API version `2017-04-06`, silent acceptance of broken print-file URLs on draft orders, and non-deletable Printful file-library entries). The order state machine, idempotent submission algorithm, layered fail-safes (ADR-0020), and CI mock strategy (ADR-0024) are sound and directly support the goal of a fully automated, low-overhead purchase pipeline.

Before starting Step 2 of the delivery plan, fold the **3 Blockers** and **6 Major Findings** below into `docs/design/` (and record any resulting ADR updates). Concrete schema, interface, and configuration proposals are included in each finding so the implementation agent can apply them without guesswork.

---

## 2. Findings

### Blockers

#### F1 — `order_items.quantity` SQLite `CHECK` constraint breaks postcard orders
- **Severity:** Blocker
- **Where:** `docs/design/07-orders-data-jobs.md` §3 (`order_items`), `docs/design/03-customer-journey.md` §3
- **What is wrong:** `order_items` defines `quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 10)` and `03 §3` specifies a quantity input of `0–10`. However, ADR-0020, `06 §8`, and `11 §2` explicitly allow up to **25 postcards** per item (`postcards ≤ 25`).
- **Why it matters:** A customer ordering 15–25 postcards passes application validation and then triggers a SQLite `CHECK constraint failed` crash during `POST /checkout`.
- **Concrete proposal:**
  1. In `07 §3`, change the column constraint to:
     ```sql
     quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 100)
     ```
  2. In `03 §3` and `05 §3`, drive both the HTML `<input type="number" max="...">` attribute and server-side validation from each SKU's `maxQuantity` in `config/skus.json` (e.g. `25` for `postcard-4x6`, `10` or `5` for others), capped by `LIMIT_ITEM_QTY` when not overridden by the SKU.

---

#### F2 — Printful file-library registration is missing from the schema, provider interface, and adapter
- **Severity:** Blocker
- **Where:** `docs/design/04-catalog-and-print-files.md` §5.4, `docs/design/06-fulfilment.md` §2–§3, `docs/design/07-orders-data-jobs.md` §3
- **What is wrong:** After the API capture showed Printful returns `200 OK` on draft orders with unreachable file URLs and fails only later, `04 §5.4` was updated to require registering print files in Printful's file library (`POST /v2/files`) and gating offer readiness on `status = 'ok'`. However, this change was not propagated to:
  - `FulfilmentProvider` (`06 §2`) — no file-registration or file-status methods.
  - Database schema (`07 §3`) — `print_files` has no provider file ID or status columns, and there is no `provider_files` table.
  - Printful adapter (`06 §3`) — order item payload still passes raw `url` without referencing the verified library entry.
  - Job runner (`07 §4`) — no `printfile.register` job or state transition from rendered → registered → ready.
- **Why it matters:** An implementer cannot enforce ADR-0019 ("print files exist and validate before a product is sold") against Printful's actual behavior without inventing schema tables and interface methods.
- **Concrete proposal:**
  1. **Extend `FulfilmentProvider` (`06 §2`):**
     ```ts
     registerFile(url: string): Promise<{ providerFileId: string; status: 'waiting' | 'ok' | 'failed' }>;
     getFileStatus(providerFileId: string): Promise<{ status: 'waiting' | 'ok' | 'failed'; reason?: string }>;
     ```
  2. **Add `provider_files` table (`07 §3`):**
     ```sql
     CREATE TABLE provider_files (
       print_file_sha   TEXT NOT NULL REFERENCES print_files(sha256),
       provider         TEXT NOT NULL,
       provider_file_id TEXT,
       status           TEXT NOT NULL, -- 'pending' | 'waiting' | 'ok' | 'failed'
       last_error       TEXT,
       checked_at       TEXT NOT NULL,
       PRIMARY KEY (print_file_sha, provider)
     );
     ```
  3. **Offer readiness rule (`04 §5.4`):** An offer is sellable (included in `GET /api/offers` and rendered on `/p/:uid`) only when `offers.enabled = 1`, `offers.print_file_sha IS NOT NULL`, and the corresponding `provider_files` row for that SKU's provider has `status = 'ok'`.
  4. **Order item payload (`06 §3`):** Clarify whether `layers` passes `{ type: 'file', id: Number(providerFileId) }` or `{ type: 'file', url }` (verify against v2 OpenAPI `FileLayer` schema; passing `id` avoids a second fetch, while passing `url` after `ok` guarantees Printful already cached it).

---

#### F3 — Single-gallery coupling blocks adding a second content source (`christina.art`)
- **Severity:** Blocker (for stated multi-source extensibility goal)
- **Where:** `docs/design/03-customer-journey.md` §1–§2, `04-catalog-and-print-files.md` §4, `06-fulfilment.md` §3, `07-orders-data-jobs.md` §3, `11-operations.md` §2, `src/pages.ts`
- **What is wrong:** The design hardcodes a single upstream gallery everywhere:
  - Env vars: `ART_URL`, `ART_CLUSTER_URL` (`11 §2`).
  - Schema: `pictures.uid TEXT PRIMARY KEY` with no source identifier (`07 §3`). `art`'s `uid` is an 8-char string from `index.json`, which is only guaranteed unique within one gallery.
  - Branding: `"Klaus Hofrichter Art"` hardcoded on Printful's packing slip (`06 §3`) and in page headers (`src/pages.ts`).
  - Discovery API: `GET /api/offers` returns a flat list of UIDs (`03 §1`).
- **Why it matters:** Connecting `christina.art` later would require breaking primary-key migrations across `pictures`, `offers`, `carts`, `orders`, and `order_items`, plus refactoring URL routing, CSP, and packing-slip branding.
- **Concrete proposal:** Add a thin multi-source configuration layer now (still zero runtime overhead with 1 source at launch):
  1. **Source configuration (`config/sources.json`):**
     ```json
     [
       {
         "id": "art",
         "default": true,
         "artistName": "Klaus Hofrichter",
         "galleryName": "art.klaushofrichter.net",
         "publicUrl": "https://art.klaushofrichter.net",
         "clusterUrl": "http://art.art.svc.cluster.local",
         "adapter": "html-manifest-script",
         "packingSlipStoreName": "Klaus Hofrichter Art",
         "contactEmail": "orders@shop.klaushofrichter.net"
       }
     ]
     ```
     (Environment overrides like `SOURCE_ART_CLUSTER_URL` allow pointing to a fake source in CI/tests without editing JSON.)
  2. **Schema (`07 §3`):** Add `source_id TEXT NOT NULL DEFAULT 'art'` to `pictures`, `offers`, `carts`, `orders`, and `order_items`. Use composite keys `(source_id, uid)` on `pictures` and `(source_id, uid, sku_id)` on `offers`.
  3. **Routing (`03 §1`):**
     - Support `GET /s/:source/:uid` as the canonical multi-source route.
     - Keep `GET /p/:uid` as a permanent alias for the `default: true` source (`art`), so `art`'s link contract (ADR-0009) does not change.
     - Support `GET /api/offers?source=art` (defaulting to the default source if omitted) so each gallery only fetches its own enabled UIDs.
  4. **Packing slip & UI (`06 §3`, `03 §3`):** Populate `customization.packing_slip.store_name`, page titles, and back-to-gallery links from the order's/picture's `source` config rather than hardcoded strings.

---

### Major Findings

#### F4 — `art`-to-`shop` contract mismatches (URL path, CSP, and `v` cache-key churn)
- **Severity:** Major
- **Where:** `docs/design/04-catalog-and-print-files.md` §4 & §5.2, `src/app.ts` (cross-checked against `art-main/src/content.ts` and `art-main/src/urls.ts`)
- **What is wrong:** Three concrete discrepancies between the shop design and `art`'s actual implementation:
  1. **Wrong derivative URL path:** `04 §4` says art serves public derivatives at `/img/...`. In `art-main/src/urls.ts`, derivatives are actually served at:
     - JPEG: `/assets/<encodeURIComponent(room.id)>/w<width>/<encodeURIComponent(file)>?v=<v>`
     - WebP: `/assets/<encodeURIComponent(room.id)>/w<width>/<encodeURIComponent(basename)>.webp?v=<v>`
     - Original: `/assets/<encodeURIComponent(room.id)>/<encodeURIComponent(file)>?v=<v>`
  2. **CSP blocks gallery images:** `src/app.ts` sets `img-src 'self' data:`. Because `04 §4` explicitly does not re-host public derivatives, browsers will block all painting images loaded from `https://art.klaushofrichter.net`.
  3. **`v` churns when derivatives are rebuilt:** In `art-main/src/content.ts` (`sized()`), `v` hashes `size:mtimeMs` of the original **plus every resized derivative**. Running `FORCE=1 make-derivatives.sh` or tweaking thumbnail quality in `art` changes `v` even when the original painting file is unchanged. Under `04 §4`, a `v` change triggers re-rendering all print files, re-registering them in Printful's append-only file library, and re-running ~2 hours of rate-limited mockup tasks.
- **Concrete proposal:**
  1. **Fix URL builder & `ManifestSource` adapter:** Isolate manifest parsing behind a `ContentSourceAdapter` interface returning normalized `SourceWork` records:
     ```ts
     interface SourceWork {
       sourceId: string;
       uid: string;
       roomId: string;
       slug: string;
       title: string;
       artist: string;
       date?: string;
       medium?: string;
       dimensions?: string;
       contentV: string;
       originalUrl: string;        // resolved against clusterUrl
       publicOriginalUrl: string;  // resolved against publicUrl
       derivatives: { width: number; jpgUrl: string; webpUrl?: string }[];
       originalStatus: 'available' | 'sold' | 'reserved' | 'nfs';
       originalBuyUrl?: string;
     }
     ```
     This keeps `<script type="application/json" id="manifest">` scraping contained to one adapter and makes adding a JSON endpoint or `christina.art`'s schema trivial.
  2. **Update CSP (`src/app.ts`):** Build `img-src` dynamically from `config/sources.json`:
     `img-src 'self' data: https://art.klaushofrichter.net` (plus any future source origin).
  3. **Avoid unnecessary re-renders on `v` churn:** Store `original_sha256` on `pictures`. When `content_v` changes, fetch the original in-cluster, hash it, and only enqueue `printfile.render` / `mockup.create` jobs if `original_sha256` actually changed. Otherwise update `content_v` (for public derivative URLs) and stop.

---

#### F5 — State machine race: `abandoned` / `expired` → `paid` can strand customer money
- **Severity:** Major
- **Where:** `docs/design/07-orders-data-jobs.md` §2, `docs/design/03-customer-journey.md` §6, `docs/design/05-quote-checkout-payment.md` §4
- **What is wrong:**
  1. `abandoned` and `expired` are marked terminal in `07 §2`. If a customer opens Checkout in two tabs, clicks Cancel in one (triggering `cancel_url` → `abandoned`) while completing payment in the other—or if a `checkout.session.completed` webhook arrives just after a local expiry—the optimistic update `WHERE state = 'checkout_open'` fails.
  2. `05 §4` transitions directly from `checkout_open` to `needs_attention` when `amount_subtotal` or `shipping_cost` mismatches, but `07 §2` does not include a `checkout_open → needs_attention` edge.
- **Why it matters:** Violates Q1 ("No lost money"): Stripe captures funds, but the order remains stuck in a terminal unpaid state (`abandoned`/`expired`) with no Printful order and no automatic refund.
- **Concrete proposal:**
  1. **Safe `cancel_url` handler (`03 §6`):** Call Stripe `checkout.sessions.expire(sessionId)` **before** transitioning to `abandoned`. If Stripe rejects expiration because `status === 'complete'` and `payment_status === 'paid'`, run the normal `paid` transition and redirect to `/order/:id?t=<token>`.
  2. **Allow late-payment recovery edges (`07 §2`):** Add edges `abandoned → needs_attention` and `expired → needs_attention` specifically for verified `checkout.session.completed (paid)` / `async_payment_succeeded` webhooks, recording `paid_cents`, `stripe_payment_intent`, and alerting Klaus immediately (with the same 24 h / 72 h auto-refund fail-safe if unresolved).
  3. **Amount mismatch path (`05 §4`):** Always transition `checkout_open → paid` first (so `paid_at`, `paid_cents`, and `stripe_payment_intent` are durably recorded), then immediately transition `paid → needs_attention` instead of skipping `paid`.

---

#### F6 — Synchronous `order-estimation-tasks` at quote time violates Q6 (`< 3 s`)
- **Severity:** Major
- **Where:** `docs/design/05-quote-checkout-payment.md` §2 step 5, `docs/design/01-requirements.md` §4 (Q6)
- **What is wrong:** `POST /cart/address` calls `POST /v2/shipping-rates` (~1 s) and then synchronously creates and polls `POST /v2/order-estimation-tasks` (~2–5 s) before redirecting to `/quote`.
- **Why it matters:** Total quote latency will routinely be 4–6 seconds, violating Q6 (`< 3 s`), and doubles Printful API usage per quote. Furthermore, the second API capture (`api-capture-findings.md`) proved that `order-estimation-tasks` **does not validate street addresses at all**—it only checks US state/ZIP consistency.
- **Concrete proposal:**
  - Remove `order-estimation-tasks` from the synchronous `POST /cart/address` flow.
  - Validate US ZIP-to-state consistency locally using a tiny static prefix-range table (< 1 KB, < 1 ms, zero external calls) alongside `POST /v2/shipping-rates`. Keep street-level address errors handled by the existing `shipment_returned` path (`06 §7`), which is appropriate at < 10 orders/week.

---

#### F7 — Customer visibility: disabling confirmation emails at launch breaks R9
- **Severity:** Major
- **Where:** `docs/design/09-notifications.md` §1, `docs/design/03-customer-journey.md` §7
- **What is wrong:** `09 §1` leaves `EMAIL_ENABLED=false` as an option at launch while noting that Stripe's receipt cannot carry the shop's private order-status link.
- **Why it matters:** Any customer who closes the browser tab after checkout loses their tracking link and must email Klaus manually—directly breaking R9 (no routine manual work) and weakening customer transparency. Because Amazon SES is already accepted (ADR-0015) and required for Klaus's alerts at launch, keeping customer emails off saves almost no implementation effort.
- **Concrete proposal:**
  1. Set `EMAIL_ENABLED=true` as the go-live default (keep the flag as an operational kill-switch, not a deferred launch feature).
  2. Ensure the `emails` table (`07 §3`) supports **multiple shipping emails** for split/multi-parcel orders by changing its primary key from `(order_id, kind)` to `(order_id, kind, ref_id)` (where `ref_id` is `''` for order-level emails and `shipment_id` for `shipped` emails). Currently `07 §3` uses `PRIMARY KEY (order_id, kind)`, which would silently drop the second parcel's tracking email when Printful splits apparel and paper across two facilities!
  3. On `GET /order/:id?t=<token>`, render a clear per-parcel breakdown (`carrier`, `tracking_number`, `tracking_url`, `estimated_delivery`, and the list of items in each parcel) so customers always know where every item is.

---

#### F8 — Public-repo leak prevention & test-only admin login safety
- **Severity:** Major
- **Where:** `docs/design/14-mock-services.md` §7.2, `docs/design/12-testing.md` §1, `scripts/capture/capture-apis.mjs`
- **What is wrong:**
  1. `14 §7.2` commits recorded real API fixtures into this **public** repository. In the 2026-11-24 capture, `acct_*` had to be manually redacted before committing (`api-capture-findings.md`).
  2. `12 §1` proposes a test-only admin login route enabled by `NODE_ENV=test`. However, `production-checks.yml` runs `e2e` against the **production Docker image** (`ENV NODE_ENV=production` in `Dockerfile`), and shipping a test-only auth bypass in app source is an unnecessary attack surface.
- **Concrete proposal:**
  1. **Harden redaction (`scripts/capture/capture-apis.mjs` & `mocks/verify/record.ts`):** Add automated regex redaction for:
     - Stripe account/customer/key IDs: `acct_[A-Za-z0-9]+`, `(sk|rk|pk)_(test|live)_[A-Za-z0-9]+`, `whsec_[A-Za-z0-9]+`
     - Printful store IDs and any `email`, `phone`, `address1`, `address2`, `name`, `ip` fields
     - Add a CI unit test that runs the redactor against synthetic secret/PII strings and asserts none survive.
  2. **Zero-backdoor admin e2e (`12 §1`):** Do **not** add a `NODE_ENV=test` login route to the app. Instead, in the `e2e` CI job, pass a known test `COOKIE_SECRET` and `ALLOWED_EMAILS=e2e@example.com` into the Docker container, and have a Playwright helper mint a real HMAC-signed `shop_admin` session cookie using the exact same signing function. This tests the real production auth middleware with zero backdoor code.

---

#### F9 — Cost guard tolerance and tax exclusion
- **Severity:** Major
- **Where:** `docs/design/06-fulfilment.md` §4 step 5, `docs/design/13-plan-and-open-questions.md` §3 #5
- **What is wrong:** `MARGIN_FLOOR_CENTS` defaults to `0`. Because Printful's shipping rates can drift by a few cents between quote time and draft confirmation (or wholesale tax rounding can shift by 1–2¢), a strict `0` floor will falsely trip `needs_attention` on normal orders.
- **Concrete proposal:**
  - Define the cost guard explicitly as:
    ```
    provider_total_cents <= (order.items_cents + order.shipping_cents)
                            - estimated_stripe_fee_cents
                            - MARGIN_FLOOR_CENTS
                            + COST_GUARD_TOLERANCE_CENTS
    ```
    with `COST_GUARD_TOLERANCE_CENTS` defaulting to `100` ($1.00) and `MARGIN_FLOOR_CENTS` defaulting to `0`.
  - Add an explicit unit test asserting that `order.tax_cents` (sales tax collected on behalf of the state) is **never** included in the revenue side of the cost guard.

---

### Minor Findings & Questions

| ID | Severity | Where | Issue & Suggested Change |
|---|---|---|---|
| **F10** | Minor | `docs/adr/0012-sales-tax-and-vat.md` | Truncated markdown (`3. Prices tax-inclusi## Decision`) and stray line (`1, plus resale certificates...`). Clean up formatting without changing the accepted decision. |
| **F11** | Minor | `.github/workflows/deploy-production.yml` (line 6) | Comment says *"Adapted from klaushofrichter/shop"* (copy-paste typo; likely meant `cams-admin`). |
| **F12** | Minor | `docs/design/14-mock-services.md` §7 & §10 | `shop-mocks` stages 1–2 (stateful HTTP mocks, mock Checkout page, control API, OpenAPI schema validation) are essential for CI. Stages 3–4 (automated recorder/comparator and live shadow mode) are valuable but high-effort; keep them explicitly **post-MVP / Step 8** so they don't delay the core shop. |
| **F13** | Question | `docs/design/04-catalog-and-print-files.md` §2, `13 §4` | Printful's `orientation` field for landscape posters/framed prints is still marked *(verify)*. Run one throwaway draft check before implementing the Printful adapter's item mapper so landscape paintings don't print rotated. |

---

## 3. Challenges to Accepted ADRs

No Accepted ADR needs to be overturned:
- **ADR-0003 (Build vs. Buy):** Confirmed. With multi-source support (`art` + future `christina.art`) and automated print-file/mockup generation from gallery originals, Shopify Starter + Printful would require manual product creation per painting per gallery and lose the unified storefront.
- **ADR-0008 (One picture per order):** Appropriate for launch. Keeping `source_id` and `uid` on `order_items` preserves an easy migration path to multi-picture carts later.
- **ADR-0017 / ADR-0018 / ADR-0024 (Provider interface, ledger/reconciliation, mock service):** Not over-engineered. Because confirmed Printful orders immediately spend real money, idempotent submission, hourly reconciliation, and CI-runnable mocks are the right baseline for a fully automated shop.

---

## 4. Things Done Well (Preserve During Implementation)

- **Real API captures before coding (`capture-apis.mjs` + `api-capture-findings.md`):** Hard-coded allow-lists and confirmation bans made real API discovery safe and surfaced critical discrepancies (Stripe's `2017-04-06` default version, Printful's silent acceptance of broken file URLs) before a line of app code was written.
- **Address-once via Stripe Customer (ADR-0023):** Avoids double address entry and address-mismatch exceptions while preserving Apple Pay / Google Pay and Stripe Tax.
- **Layered fail-safes (ADR-0020):** Hard checkout limits, approval holds with 72 h automatic refund, and a 24 h volume circuit breaker bound financial exposure without adding friction to normal orders.
- **Strict secret & mock isolation (`create-secrets.sh --mock`, prefix/host guards):** Enforces R19 ("no real transaction in test deployments") by construction rather than convention.
- **CI baseline (`production-checks.yml`):** Already green on `main` with `npm audit`, CodeQL, 4-browser Playwright + axe-core WCAG 2.2 AA, and Lighthouse gates.

---

## 5. Pre-Implementation Action Checklist (For the Implementation Agent)

- [ ] **F1:** Update `order_items.quantity` constraint in `07 §3` to `BETWEEN 1 AND 100` and drive UI/server caps from `config/skus.json` `maxQuantity`.
- [ ] **F2:** Add `registerFile` / `getFileStatus` to `FulfilmentProvider` (`06 §2`), add `provider_files` table (`07 §3`), and gate offer readiness on `status = 'ok'`.
- [ ] **F3:** Add `config/sources.json` and `source_id` columns to `pictures`, `offers`, `carts`, `orders`, `order_items`; add `/s/:source/:uid` with `/p/:uid` aliasing the default source; parameterize `GET /api/offers?source=`.
- [ ] **F4:** Fix `art` derivative URL template to `/assets/<roomId>/w<width>/<file>?v=<v>`, add source origins to `img-src` in `src/app.ts`, and gate print-file re-renders on `original_sha256` rather than `content_v`.
- [ ] **F5:** Expire Stripe session before marking `abandoned` on `cancel_url`; add `abandoned`/`expired → needs_attention` late-payment edges; record `paid` before `needs_attention` on amount mismatch.
- [ ] **F6:** Remove synchronous `order-estimation-tasks` from `POST /cart/address` and replace with local US ZIP-to-state validation.
- [ ] **F7:** Default `EMAIL_ENABLED=true` at go-live; change `emails` PK in `07 §3` to `(order_id, kind, ref_id)` so multi-parcel shipments each send a tracking email.
- [ ] **F8:** Harden capture redaction (`acct_*`, store IDs, PII) and use Playwright HMAC cookie minting instead of a `NODE_ENV=test` admin login route.
- [ ] **F9:** Add `COST_GUARD_TOLERANCE_CENTS` (default `100`) and unit-test that `tax_cents` is excluded from cost-guard revenue.
- [ ] **F10–F11:** Fix markdown typo in ADR-0012 and comment typo in `deploy-production.yml`.