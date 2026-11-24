# Design Review Commentary — Round 2 & Pre-Implementation Sign-Off

- **Date:** 2026-11-26
- **Reviewed:** `klaushofrichter/shop` (`main` branch: revised `docs/design/01–14`, ADRs `0001–0036`, `docs/reviews/2026-11-25-triage.md`, `docs/reviews/2026-11-26-design-review-round-2-{a,b}.md`, `docs/reviews/2026-11-26-triage-round-2.md`, `scripts/capture/capture-apis.mjs`, `src/*`) and `klaushofrichter/art` (`src/content.ts`, `src/urls.ts`, `src/routes/buy.ts`, `src/views/buy.ts`).
- **Secrets & Public-Repo Check:** Clean. No secrets, tokens, or private keys exist in the repository; the raw capture branches are gone (moved to `shop-private` per ADR-0028), and the Google Cloud project name and node paths have been scrubbed from public docs.

---

## 1. Executive Verdict

**Verdict: Ready to implement once Klaus signs off on D1–D10 and the 4 small caveats in §4 are folded in.**

The round-2 revision and its triage (`2026-11-26-triage-round-2.md`) are a major leap forward. Splitting order state into `payment_state`, `fulfilment_state`, `dispute_state`, and `holds` with explicit invariants (`I1–I10`), introducing `ContentSource` + local display images (ADR-0035), moving to a single `SHOP_MODE` with a dedicated Printful test store (ADR-0029), and enabling customer e-mails at launch (ADR-0027) close all structural gaps from round 1.

**Strong recommendation: do not run a Round 3 design review.** After four independent reviews across two rounds, the design is well past the point of diminishing returns. Freeze the design once D1–D10 are folded in and begin Step 2 of `13-plan-and-open-questions.md`.

---

## 2. Closure of Our Round-1 Findings (F1–F13)

Every finding from `2026-11-24-design-review-2.md` was addressed cleanly:

| Round-1 ID | Status | How it was resolved in Round 2 |
|---|---|---|
| **F1** (`order_items.quantity` CHECK) | **Closed** | `CHECK (quantity >= 1)` in `07 §3`; per-SKU `maxQuantity` drives form and server validation. |
| **F2** (Printful file-library wiring) | **Closed** | Added `registerFile` / `getFileStatus` (`06 §2`), `provider_files` table (`07 §3`), `visible: false` (`04 §5.3`), and offer sellability gating. |
| **F3** (Multi-source coupling) | **Closed** | `ContentSource` interface, `config/sources.json`, composite `(source_id, work_id)` keys everywhere, `/p/:source/:work` with `/p/:work` alias, `/api/offers?source=…` (ADR-0035). |
| **F4** (`art` URLs, CSP, `v` churn) | **Closed (improved)** | Fixed `/assets/<room>/<file>?v=<v>`, gated re-renders on `original_sha256`, and went one step better on CSP: the shop renders its own metadata-free display images so CSP stays `img-src 'self'`. |
| **F5** (Late payment / state races) | **Closed** | Replaced single `state` with `payment_state` / `fulfilment_state` / `dispute_state` / `holds` (ADR-0034); `cancel_url` is side-effect free; `closed_unpaid → paid` always wins (`I1`). |
| **F6** (`order-estimation-tasks` latency) | **Closed** | Removed from synchronous quote path; replaced with local US ZIP↔state table + cached-price pre-payment cost check (ADR-0036). Quote stays 1 Printful call (< 3 s). |
| **F7** (Customer e-mails & multi-parcel PK) | **Closed** | Customer e-mails enabled at launch (ADR-0027); `emails` PK updated to `(order_id, kind, ref)` so split parcels each send a tracking e-mail. |
| **F8** (Public redaction & no test login) | **Closed** | Raw captures moved to `shop-private` with CI synthetic-fixture checks (ADR-0028); admin e2e mints a real signed cookie with no test-only login route (`12 §1`). |
| **F9** (Cost guard & tax exclusion) | **Closed** | Customer tax explicitly excluded from revenue and unit-tested (`06 §4`, `12 §1`). Keeping a single `MARGIN_FLOOR_CENTS` knob is clean. |
| **F10–F11** (Doc & workflow typos) | **Closed** | ADR-0012 markdown and `deploy-production.yml` comment fixed. |
| **F12** (Mock build phasing) | **Closed** | Shadow mode dropped; recorder/scrubber/comparator deferred to post-MVP Step 11 (`13 §1`, `14 §10`). |
| **F13** (Landscape `orientation` check) | **Tracked** | Explicitly tracked in `13 §4` as a 1-draft test-store check before writing the item mapper. |

---

## 3. Commentary on Klaus's Decisions (D1–D10)

All ten recommendations in `docs/reviews/2026-11-26-triage-round-2.md` §1 are sound. Below is a quick sign-off note with small refinements to fold in when updating the docs:

| Decision | Recommendation | Commentary |
|---|---|---|
| **D1** (Accept ADR-0034 + §2) | **Approve** | Using `DELETE /v2/orders/{id}` as the uncharged-order proof (instead of a read), limiting `I7` cancellation to full refunds, adding `I10`, and making webhooks/polls attempt-aware resolve every state-machine edge case found by Reviewers A and B. |
| **D2** (Shared catalog DB) | **Approve with caveat (see R2-C1)** | Essential so go-live does not wipe Klaus's catalog setup. Fold in the SQLite cross-DB FK and Litestream adjustments in **R2-C1** below. |
| **D3** (Test mode only before go-live; mock CI-only) | **Approve with caveat (see R2-C4)** | Big simplification that matches R11 (< 10 orders/week). Removes an entire cluster deployment, ingress, cert, and `/__mock-pages/` routing. |
| **D4** (`config/sources.json` allow-list for `art`) | **Approve** | Unblocks launch cleanly without waiting on `art`'s repository, while preserving `printsAllowed` for when `art` adds a feed. |
| **D5** (`STATUS_TOKEN_SECRET` HMAC) | **Approve with caveat (see R2-C3)** | Clean fix for e-mails and "find my order". Derive HMAC from **`order_id`**, not `order_number` (see **R2-C3**). |
| **D6** (Amend ADR-0010 billing holds) | **Approve** | Never auto-refund a confirmed order on a Printful billing hold; alert daily instead. |
| **D7** (ADR-0020 notes) | **Approve** | Clarifies breaker-only release and ensures deployed thresholds in `kube-setup` differ from the public proposals. |
| **D8** (Accept ADR-0029, 0030, 0036) | **Approve** | All three are clean, low-overhead, and well-verified against real API behavior. |
| **D9** (Packing slip contact) | **Approve** | Setting `orders@shop.klaushofrichter.net` on the packing slip prevents Printful from printing a personal account address and sends zero customer PII. |
| **D10** (SES bounces via SQS) | **Approve** | Polling SQS avoids exposing a public SNS webhook endpoint and fits the existing in-process job runner. |

---

## 4. Remaining Catch-Items & Implementation Caveats

These four items were not caught by the round-2 reviews or were introduced by the round-2 triage itself. None requires a redesign; fold them directly into the design docs alongside D1–D10.

### R2-C1 — Major — Splitting `catalog.db` and `live.db` (D2) breaks SQLite foreign keys and needs two Litestream targets
- **Where:** `docs/reviews/2026-11-26-triage-round-2.md` (D2), `docs/design/07-orders-data-jobs.md` §3 & §6, `docs/design/11-operations.md` §3
- **Problem:**
  1. In `07 §3`, `order_items` declares `print_file_sha TEXT NOT NULL REFERENCES print_files(sha256)`. **SQLite does not support foreign-key constraints across separate (`ATTACH`ed) database files.** Moving `works`, `offers`, `display_images`, `print_files`, and `provider_files` into a shared `catalog.db` while keeping `orders` / `order_items` in `live.db` (and `test.db`) will fail at migration time if that `REFERENCES` clause stays.
  2. `11 §3` configures Litestream for a single database file. With `catalog.db` + `live.db`, losing the node without replicating `catalog.db` would lose Klaus's entire offer/crop/price setup and break `print_file_sha` lookups for active orders.
  3. The `purge` job (`07 §6`) deletes unreferenced print files, but must not delete a file in `catalog.db` that is still referenced by an order item in `live.db` from the last 12 months.
- **Concrete fix:**
  1. Drop the SQLite `REFERENCES print_files(sha256)` foreign key from `order_items` (enforce existence in application code at `POST /checkout`, and optionally assert referential integrity in the hourly reconciliation job).
  2. Replicate **both** `catalog.db` and `<mode>.db` in Litestream (`litestream.yml`), and update the restore runbook (`11 §5`) to restore both.
  3. In the `purge` job, only prune `print_files` when running in `live` mode (or after checking `live.db` if present), so a `test`-mode purge can never delete a live order's print file.

### R2-C2 — Major — `scripts/capture/capture-apis.mjs` still targets the live Printful token
- **Where:** `scripts/capture/capture-apis.mjs` (line 40)
- **Problem:** ADR-0029 mandates that all recordings use the Printful **test store** (`PRINTFUL_TOKEN_TEST`), and ADR-0028 mandates that raw captures go only to `shop-private`. However, `capture-apis.mjs` still reads `env.PRINTFUL_TOKEN` (the live store) and defaults `--out` to `captures/<date>` inside the current working directory.
- **Concrete fix:**
  1. Change `capture-apis.mjs` to read `env.PRINTFUL_TOKEN_TEST` (refusing `PRINTFUL_TOKEN` entirely).
  2. Refuse to run if `--out` resolves inside the `shop` git repository (force writing to a path outside the public repo, e.g., a `shop-private` checkout).

### R2-C3 — Minor — D5 HMAC input (`order_id` vs `order_number`) and unused schema column
- **Where:** `docs/reviews/2026-11-26-triage-round-2.md` (D5), `docs/design/07-orders-data-jobs.md` §1 & §3
- **Problem:** Triage D5 says `HMAC(secret, order number)`, whereas Reviewer B (R2-B-F6) proposed `HMAC(STATUS_TOKEN_SECRET, order_id)`. Also, `orders.status_token_hash` in `07 §3` becomes redundant once tokens are stateless HMACs.
- **Concrete fix:**
  1. Derive the token from **`order_id`** (`HMAC-SHA256(STATUS_TOKEN_SECRET, order_id)`, base64url, truncated to 128 bits) so it binds directly to the `/order/:id` route parameter and never collides even if order-number formatting changes later.
  2. Remove `orders.status_token_hash` from `07 §3` (or document it as dropped in favor of `STATUS_TOKEN_SECRET`), and add `STATUS_TOKEN_SECRET` to `.env.example` and `11 §1`.

### R2-C4 — Minor — Test-mode auto-delete/auto-refund vs. manual test-mode checklist
- **Where:** `docs/reviews/2026-11-26-triage-round-2.md` §2 (last row), `docs/design/12-testing.md` §3 (items 3 & 4)
- **Problem:** Triage §2 specifies that in `test` mode, right after the cost guard passes, the shop immediately deletes the Printful draft and refunds in Stripe test mode. However, `12 §3` item 3 checks that the Printful draft was created with the right items/files/recipient, and item 4 tests *"refund from the admin; refund from the Stripe Dashboard"*. If every test order auto-refunds in seconds, Klaus cannot inspect the draft or click Refund in the admin/Dashboard.
- **Concrete fix:** In `test` mode, after the cost guard passes, mark `fulfilment_state = 'test_draft_ok'` (terminal for reconciliation so it never alarms or polls hourly), leave the draft in the test store for inspection until the nightly 7-day purge deletes it, and leave the Stripe test payment unrefunded so Klaus can exercise admin/Dashboard refunds manually.

---

## 5. Multi-Source & `art` Contract Check

Verified against `art-contract_2.txt`:
- `ADR-0035` (`ContentSource` + `config/sources.json` + local display images + `original_sha256` gating) aligns cleanly with `art`'s actual `src/content.ts` and `src/urls.ts`.
- Keying `works`, `offers`, `cart_items`, and `order_items` by `(source_id, work_id)` ensures that adding `christina.art` or `instagetter` later requires **zero schema migrations**—only a new `ContentSource` adapter and an entry in `config/sources.json`.

---

## 6. Next Step

1. Klaus confirms **D1–D10** (with the small adjustments in **R2-C1** through **R2-C4**).
2. Fold the round-2 triage + R2-C1–R2-C4 into `docs/design/`, the ADRs, and `scripts/capture/capture-apis.mjs` in a single PR.
3. Start **Step 2** (database migrations, modes/startup guards, config loading, `Clock`, job runner).