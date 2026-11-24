# Triage of the round-2 design reviews

- Reviewer A: `2026-11-26-design-review-round-2-a.md` (14 findings, "ready after listed changes").
- Reviewer B: `2026-11-26-design-review-round-2-b.md` (18 findings, "ready to implement after the listed changes").
- "A F1" = reviewer A, finding R2-A-F1. Neither review asks for a redesign; both found no path by which a test order reaches a live service, and none by which money is stranded through the checkout.
- §1 lists what Klaus decides. Everything else is adopted by the author unless marked otherwise, and is folded into `docs/design` and the Proposed ADRs after Klaus's decisions.

## 1. For Klaus to decide

| # | Topic | Findings | Recommendation |
|---|---|---|---|
| D1 | **Accept ADR-0034** (order state model) with the changes of §2 | A F1–F8, F10, F11; B F1, F7, F8, F17 | Accept with §2 folded in. |
| D2 | **Catalog after go-live**: Klaus's setup (enabled works, offers, prices, crops) lives in the per-mode database, so `live` starts empty | B F3 | **One catalog file shared by all modes**; orders, carts, quotes, jobs and events stay per mode. Printful file registrations are kept per store. |
| D3 | **Test mode after go-live**: nothing describes a second deployment; the Stripe test webhook would hit the live host | B F4, A F9 | **Test mode only before go-live**, on the same deployment. At go-live: disable the Stripe test-mode endpoint and the test store's webhook. Real-service checks after go-live are run by hand from a temporary test deployment (Cluster). **Mock mode runs only in CI**, never on the cluster (B F16). The alternative, a permanent test deployment, needs a second host name, certificate and Secret. |
| D4 | **Which of art's works may be printed**, before art has a works feed: art's default is "no", so nothing can be enabled at launch | B F5 | A per-work **allow-list in the shop's `config/sources.json`**, filled from Klaus's decision for art, used until art publishes the flag itself. (Accept ADR-0035 with this.) |
| D5 | **Status links in e-mails**: only a hash of the token is stored, so later e-mails can't carry the link | B F6 | Derive the link token as HMAC(secret, order number); a **new secret** `STATUS_TOKEN_SECRET` in the shop's `.env` (Klaus). Rotating it revokes every link. |
| D6 | **ADR-0010** still says "automatic full refund after 72 h on a Printful billing hold" | A §4, B §4 | Amend: on a billing hold the shop **alerts and never refunds by timer** (Printful would charge and ship once billing is fixed). Daily reminder alert while it lasts. Recorded as superseded in part by ADR-0034. |
| D7 | **ADR-0020** threshold proposals are public, and the release rule after a breaker reset differs from the design | A §4, B §3 (R1 F27) | Note in ADR-0020 that only breaker-only holds are released, and that the deployed values are set privately and **should differ** from the published proposals (Klaus sets them in kube-setup). |
| D8 | **Accept ADR-0029** (mode switch), **ADR-0030** (Stripe webhooks, plus disabling the test endpoint at go-live), **ADR-0036** (quote checks) | B §4 | Accept, with D2 and D3 folded into ADR-0029/0030. |
| D9 | **Packing slip contact**: if left empty, Printful may print the store's default contact | B F18 | Put a shop contact address (e.g. an `orders@` mailbox, Klaus's choice) on the packing slip; check with one test-store draft. |
| D10 | **SES bounce reports**: how they reach the shop | B F13 | Poll an SQS queue (no public endpoint). Needs an SQS queue and IAM permission in Klaus's AWS account (cost: negligible). |

## 2. State model (ADR-0034): adopted

| Change | Findings |
|---|---|
| **Delete is the proof, not a read.** An automatic refund needs every attempt of the order proven not chargeable: not found, `draft` deleted, `canceled`, or a successful `DELETE /v2/orders/{id}` (allowed only for uncharged orders). Refused delete → `alert`. "`failed` and not charged" is replaced by that delete. | A F1, F8; B F8 |
| After a confirm with no answer: a **quiet period** (client timeout + 2 min) before any read that can lead to a delete or a refund. | A F1 |
| **Only a full refund cancels.** I2, I3 and I7 apply when `refunded ≥ paid` or the refund was issued by the shop to cancel. A partial refund is an event and a status line, nothing else. "Refund anyway" on an order in production opens no hold. | A F2; B F1 |
| **Refunds table** (requested, succeeded, failed). A failed refund returns the order to a hold with a longer deadline; admin actions "retry refund" and "fulfil anyway". | A F3 |
| **Dispute transitions**: `warning → none` when Klaus approves; `dispute.created` rewrites open fraud holds to `alert`; never an automatic refund while a dispute is open or lost (`charge_disputed` is final); `dispute.closed` resolves the hold. **Deadline action per reason**, not per kind; early fraud warning before confirm refunds at once. | A F4; B F8 |
| **I10**: every paid order not at an end state has a runnable job, an open hold with a deadline, or a refund in progress. A submit that finds I2 false opens an `attention` hold. Provider outage past the retry window → `attention` hold whose deadline refunds only if I4 allows. | A F5; B F17 |
| **Attempt-aware**: webhooks and polls resolve to an attempt by `external_id`; only the newest attempt drives `fulfilment_state` and holds; a cancel the shop issued never opens a refund hold; I4 covers all attempts. Attempt N+1 is started by the admin "retry submission" or by the route below. | A F6 |
| **I3 restated** by what it protects: confirm only inside a transaction that sees no full refund and no open hold. Re-confirming the **same** provider order after a fresh read shows `draft` is allowed (one Printful order can't be charged twice). Persistent failure → delete, new attempt, at most 3 attempts, then `attention`. Test oracle: at most one confirmed provider order per paid order. | A F7; B F7 |
| Fulfilment **edge table**; "end state" is the order's, not an attempt's. | A F10 |
| Holds resolved with a conditional update; only the winner acts. | A F11 |
| Re-read the charge's `amount_refunded` from Stripe just before confirm. | A F13 (question; adopted, one call) |
| Derived status: hold rows only before the first shipment; "Refunded — your item may still arrive" after shipment; a partially refunded row. The "delayed" e-mail only before the first shipment. | A F14; B F11 |
| Test mode: after the cost guard, delete the draft at once, `fulfilment_state = canceled`, cause `test_mode`, no hold, no alert; refund in Stripe test mode to exercise that path. The mock confirms (as live does). | B F12 |

## 3. Other changes: adopted

| Change | Findings |
|---|---|
| `/files/*`, `/img/*`, `/mockups/*` are exempt from the preview gate (Printful and Stripe fetch them without a cookie); e2e checks it. | B F2 |
| Print-file URLs come from the mode's `PUBLIC_URL`. The Printful webhook script checks mode and store and shows the old configuration before replacing it. The expected store per mode comes from a separate variable (value in kube-setup); a live start with the test store is refused. Outside live mode the provider adapter has **no confirm method**. | A F9; B F14 |
| Cart: a unique index allows one `checkout_open` order per cart; an expire refused as "already complete" applies the payment and shows the status page; the first `paid` empties the cart and detaches the order; a lost session id is recovered by repeating the create with the same idempotency key, else `closed_unpaid` with a note. | A F12; B F10 |
| E-mails: `link` e-mails get a `ref` per request, admin resends a fresh `ref`; `emails.provider_message_id` for bounces. | B F6, F13 |
| Name all configuration (Printful webhook public key, both Stripe webhook secrets, `PREVIEW_KEY`, SES, the fee estimate, the retry window) in 11 §2.2 and `.env.example`, private values marked "in kube-setup". | B F14 |
| Fixtures before the scrubber exists: hand-written from the spec and the private captures, checked by the CI fixtures check. | B F15 |
| Simplifications: hand-written schemas for the Stripe endpoints the shop calls (full OpenAPI validation only for Printful); the address only on the quote; backups Litestream + nightly copy at launch (Velero is the cluster's anyway). | B F16; A over-engineering |
| Reshipments: an admin "reship" creating a provider order with `external_id` `<order>-r1`, recorded as a reshipment, so the reverse sweep knows it. | B §3 (R1 §2.7) |
| Privacy text: Stripe keeps name and address on the payment records; backups keep purged data for their retention. | B §3 (R1 F28) |
| Stale texts: ADR-0018 (`order_events`), ADR-0021 (status line), ADR-0024 (note: drafts in the test store, no shadow mode), `api-capture-findings.md` "Design changes" (note what was reversed), `print_files.render_key` with orientation, Q1 and the test oracle allow "confirmed, then cancelled by Printful". | B §3 (R1 §2.8) |
| The Google Cloud project name and a path were removed from public texts. | B §3 (R1 F27) |

## 4. For Cluster

| Change | Findings |
|---|---|
| Runner: `kubectl` in the image (no download, no `sudo`); smoke test from a GitHub-hosted job or egress to the shop's Ingress; allow-list from GitHub's documented runner hosts; an admission policy so the runner can change only the shop's image digest (patch on the Deployment otherwise reaches every Secret in the namespace); ephemeral runner. | B F9 |

## 5. Addendum: reviews C and D (2026-11-26)

- Reviewer C: `2026-11-26-design-review-round-2-c.md` (20 findings, "ready to implement after the listed changes"; also comments on this triage).
- Reviewer D: `2026-11-26-design-review-round-2-d.md` (commentary and sign-off, 4 catch-items R2-C1–C4; recommends no third round).
- Klaus, 2026-11-26: "decision 3: ok. decision 5: ok … decision 10: ok. New: ok". Later the same day: "decisions 1, 2, 4, 6, 7, 8, 9: ok". Every decision of §1 is taken.

### Changes to this triage

| Item | Change | Source |
|---|---|---|
| D3 | Accepted by Klaus, including that the first cluster deployment uses Stripe test mode and test-store drafts (R19 reworded); no weekly run, no scheduled recorder | C §3; Klaus |
| D5 | HMAC over the **order id**, not the order number; `status_token_hash` dropped. ADR-0037, accepted | C §3, D R2-C3; Klaus |
| D10 | **SES e-mail forwarding** instead of an SQS queue; no `provider_message_id`. ADR-0038, accepted | C §3; Klaus |
| New | The preview gate is its own switch; live mode starts gated; Klaus's first orders are recorded for Printful only. ADR-0039, accepted (amends ADR-0028) | C F5; Klaus |
| D2 | Consequences written down: no foreign key from order items to print files (checked in code), Litestream replicates both files, the print-file purge runs only in live mode against `live.db`, `provider_files` keyed by store | C §3, D R2-C1 |
| §2, test mode | The draft stays in the test store for inspection (deleted after 7 days), the payment is **not** auto-refunded, `fulfilment_state = test_draft_ok`, the order is complete. "No confirm method" means in **test** mode; the mock confirms | D R2-C4, C §3 |
| §3, reship | **No admin reship action.** Klaus reships in Printful's dashboard; the reverse sweep's alarm offers "link to order N" | C §3 |

### Review C: adopted

| Finding | Change | Where |
|---|---|---|
| C-F1 | Payment, fail-safes and the hold or submit job in **one transaction**; `failsafe_checked_at`; invariant I11; restarts in the random sequences | 07 §2.1, 05 §4, 06 §8, 12 §1 |
| C-F2 | Refuse to start only on a wrong answer; no answer → start with Printful unverified | 06 §3, 11 §2.1 |
| C-F3 | **Completion** (`completed_at`) ends polling and starts retention; `return_to_sender`/`failure` shown per parcel | 07 §2.7, 06 §5 |
| C-F4 | `/health/worker` checked by the uptime monitor as the second alert channel; timeouts on every call | 11 §4, 07 §4 |
| C-F5 | Go-live behind the gate; recording aligned (Printful only); the export built before step 10 | 12 §4, 14 §7.3, 13 §1, ADR-0039 |
| C-F6 | Line items paged; `metadata.order_item_id`; tax lines checked | 05 §3–4 |
| C-F7 | Webhook endpoints at the latest version; the version doesn't matter | 05 §4, ADR-0030 |
| C-F8 | In mock mode the shop passes `/__mock-pages/*` to the mock (same origin) | 14 §9 |
| C-F9 | `MAX_INPUT_MEGAPIXELS` from the memory test | 04 §5, 12 §1 |
| C-F10 | DPI table corrected; one work refused at 12 × 16 | 04 §2, 01 A2, ADR-0033 |
| C-F11, D R2-C2 | Capture script: test-store token only, `--out` required and refused inside this repository; `captures/` git-ignored | `scripts/capture/` |
| C-F12 | Five items added to the verify list | 13 §4 |
| C-F13 | Never-paid orders deleted after 7 days, numbers freed | 07 §6, ADR-0032 |
| C-F14 | No Stripe payloads stored; no customer data in alerts; short ship-to in e-mails; e-mail and address only on the quote | 07 §3, 09, 10 §4 |
| C-F15 | "Confirm anyway" on the attempt; `breaker_reset_at`; a full refund resolves all holds; the reverse sweep applies I1; a permanent item error refunds the whole cart with a clear e-mail | 07 §2.5, 06 §7–8, 09 |
| C-F16 | ZIP table source, exceptions as tests, unknown prefixes accepted, rejections counted | 05 §2, ADR-0036 |
| C-F17 | One shop name on every packing slip | 06 §3, ADR-0035 |
| C-F18 | `title_override`; originals only for opened or enabled works; on-demand admin thumbnails | 04 §4, 07 §3 |
| C-F19 | `print_files.deleted_at`; shipment estimates as two dates, shipment and delivery status, provider and attempt | 07 §3 |
| C-F20 | Knative egress and the deploy token as an environment secret: for Cluster | 11 §1 |
| C §4 (R17, R19, `06 §4`) | R17 reworded; R19 reworded; "confirm in mock and live" | 01, 06 |
| C §6 | `dispute_state` kept: I2 and the customer status read it; the hold carries the action | — |
