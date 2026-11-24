# 13. Delivery plan and open questions

Revised for review round 2 (2026-11-25); round-2 findings folded in 2026-11-26. **The design is frozen** for implementation: no third review round; later changes are ADRs.

## 1. Build order

Each step is one or more PRs to `main`, merged when green; nothing reaches customers
before step 10. Mock pieces are built with the step that needs them ([14 §10](14-mock-services.md#10-build-order)).

| Step | Content |
|---|---|
| 1 | ~~Repository baseline, skeleton, CI~~ (done) |
| 2 | Database and migrations (`catalog.db` and the mode's file), modes and startup checks (no answer ≠ wrong answer), config (SKUs, sources with the allow-list), the `Clock`, the job runner with its heartbeat and `/health/worker`; the capture script's guards |
| 3 | The art source adapter with its contract test; display images; the Printful adapter for catalog, shipping rates, files; mock Printful stage 1 |
| 4 | Admin: sign-in (PKCE, minted-cookie e2e), works, offers, anchors, print files, registration, mockups |
| 5 | Public pages: picture pages, cart, address with the ZIP↔state table, quote with the pre-payment cost check, preview gate |
| 6 | Checkout (Customer, Session with the round-2 parameters, one open checkout per cart), Stripe webhooks and re-fetch, return pages, status page with the cookie, find my order; mock Stripe stage 2 |
| 7 | The payment transaction with the fail-safes; submission with the invariants I1–I11, Printful webhooks per attempt, shipments, holds and deadlines per reason, refunds, disputes and early fraud warnings, completion, forward and reverse reconciliation, purge; mock stage 3; invariant tests with restarts |
| 8 | E-mails to customers (status links from `STATUS_TOKEN_SECRET`) and alerts via SES; bounce and complaint notices forwarded to Klaus by SES |
| 9 | `scripts/create-secrets.sh`; the `inbound_events` export and adapter trace (14 §7.3); first deployment in **test** mode (Cluster: namespaces, hardened runner, PVC, Litestream with two files, Ingress, NetworkPolicy, ConfigMap with thresholds and store ids, `production` branch); art's link (art's session) |
| 10 | Test mode against the test store and Stripe test mode ([12 §3](12-testing.md#3-against-the-real-services-before-go-live)); then the go-live checklist: live behind the preview gate, Klaus's orders recorded, gate off |
| 11 | After the MVP: recorder, scrubber, comparator |

## 2. Decisions

All ADRs are Accepted except those listed as Proposed in the [ADR index](../adr/README.md)
(round 2: 0029 mode part, 0030, 0034, 0035, 0036 await Klaus's decision, with the round-2 changes folded in).

Klaus's, outside the ADRs:

| Item | Needed by |
|---|---|
| Retail prices per SKU (config defaults are placeholders) | step 10 |
| Fail-safe threshold values (kube-setup ConfigMap) | step 9 |
| Repository setting: require approval for all outside contributors' workflow runs (Cluster applies) | step 9 |
| Stripe webhook endpoints in the Dashboard, test now and live at go-live (ADR-0030) | step 10 |
| Stripe Tax registrations (test mode for testing; the home state for live); resale certificate at Printful | step 10 / go-live |
| SES domain records at Squarespace; production access | step 8 / go-live |
| S3 bucket and IAM user for backups | step 9 |
| The private repository `shop-private` (with Cluster) and deletion of the public capture branches | before step 3 |
| Which of art's works may be sold: the allow-list in `config/sources.json` (ADR-0035) | step 10 |
| `STATUS_TOKEN_SECRET` in the shop's `.env` (Cluster can generate it unseen) | step 8 |
| The shop's orders address for the packing slip and contact page | step 7 |
| SES bounce and complaint forwarding to that mailbox | step 8 |
| Legal texts | go-live |

## 3. Review round 2

Done: four reviews (A, B, C, D), triaged in `docs/reviews/2026-11-26-triage-round-2.md`
and folded into this design set on 2026-11-26.

## 4. Items to verify

Verified by captures on 2026-11-24 ([research](../research/api-capture-findings.md)):
shipping without address collection, tax from the Customer's address (amount pending),
the clothing tax code, v1 cancel of a draft, `@external_id` lookup, error shapes,
Stripe shapes with the pinned version, address checks of the estimate (state/ZIP only),
file library `ok`/`failed`. Test-store token: same scopes as the live store's (Cluster).

Still open:

| Item | How |
|---|---|
| `orientation` on an unframed poster draft (landscape) | one draft in the **test store** |
| The packing slip with the shop's contact (what Printful prints when it is empty) | the same draft |
| Printful's webhook signature against a real delivery | `order_created` of that draft, received by the shop in test mode |
| `GET /v2/stores` for a store-level token (exactly one store?) | one read in test mode |
| The new variants (6 × 8, 12 × 16, framed 12 × 16) and their print areas | the startup catalog check in test mode |
| The full Checkout Session of [05 §3](05-quote-checkout-payment.md#3-checkout-session) (all parameters together) | one test-mode create |
| Whether Link payments carry `latest_charge.outcome` and a fingerprint | one Link payment in test mode |
| `visible: false` and `role: printfile` on file registration | one registration in the test store |
| Stripe Tax amounts, including shipping tax in Texas | test-mode registration (Klaus) |
| A Stripe webhook delivery in the pinned shape | the test-mode endpoint (ADR-0030) |
| Everything after a Printful confirmation | recorded during the go-live orders |
