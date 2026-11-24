# 13. Delivery plan and open questions

Revised for review round 2 (2026-11-25).

## 1. Build order

Each step is one or more PRs to `main`, merged when green; nothing reaches customers
before step 10. Mock pieces are built with the step that needs them ([14 §10](14-mock-services.md#10-build-order)).

| Step | Content |
|---|---|
| 1 | ~~Repository baseline, skeleton, CI~~ (done) |
| 2 | Database and migrations (the round-2 schema), modes and startup checks, config (SKUs, sources), the `Clock`, the job runner |
| 3 | The art source adapter with its contract test; display images; the Printful adapter for catalog, shipping rates, files; mock Printful stage 1 |
| 4 | Admin: sign-in (PKCE, minted-cookie e2e), works, offers, anchors, print files, registration, mockups |
| 5 | Public pages: picture pages, cart, address with the ZIP↔state table, quote with the pre-payment cost check, preview gate |
| 6 | Checkout (Customer, Session with the round-2 parameters, one open checkout per cart), Stripe webhooks and re-fetch, return pages, status page with the cookie, find my order; mock Stripe stage 2 |
| 7 | Submission with the invariants, Printful webhooks, shipments, holds and deadlines, fail-safes, refunds, disputes and early fraud warnings, forward and reverse reconciliation, purge; mock stage 3; invariant tests |
| 8 | E-mails to customers and alerts via SES, bounces |
| 9 | `scripts/create-secrets.sh`; mock-mode deployment (Cluster: namespaces, hardened runner, PVC, Litestream, Ingress, NetworkPolicy, ConfigMap with thresholds, `production` branch); art's link (art's session) |
| 10 | Test mode against the test store and Stripe test mode ([12 §3](12-testing.md#3-against-the-real-services-before-go-live)); then the go-live checklist and Klaus's go |
| 11 | After the MVP: recorder, scrubber, comparator; recording during the go-live orders |

## 2. Decisions

All ADRs are Accepted except those listed as Proposed in the [ADR index](../adr/README.md)
(round 2 adds 0030, 0034, 0035, 0036 as Proposed for review).

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
| Which of art's works may be sold (art's decision) | step 10 |
| Legal texts | go-live |

## 3. Questions for review round 2

1. **State model** ([07 §2](07-orders-data-jobs.md#2-state-model)): do the three parts, the holds and the invariants I1–I9 close every gap found in round 1 (late payment, double sessions, refund during unknown state, Dashboard refunds, disputes)? Is anything still a terminal state that hides money or a shipping order?
2. **Submission** ([06 §4](06-fulfilment.md#4-submission)): is the confirm step safe under every partial failure (timeout after success, crash after `confirm_requested_at`, refund racing the confirm)?
3. **Pre-payment checks** (ADR-0036): is a local ZIP↔state table plus a cost check from cached prices enough, given the captures?
4. **Holds and deadlines**: can a deadline ever refund a confirmed order (I4)? Can a breaker reset release an order with another reason?
5. **Sources** (ADR-0035): is the `Work` contract and the art adapter enough for christina-art or instagetter later without schema changes?
6. **Privacy** (ADR-0031): does any path still send personal data that isn't needed?
7. **Modes** (ADR-0029): can a test order ever reach the live store, the live database or a real payment?
8. **Mocks** ([14](14-mock-services.md)): are the scenarios in §6 enough to exercise the invariants?
9. **Runner** ([11 §1](11-operations.md#1-deployment)): is the hardened runner plus the approval setting enough for a public repository?
10. **Still over-engineered** for < 10 orders a week?

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
| `visible: false` and `role: printfile` on file registration | one registration in the test store |
| Stripe Tax amounts, including shipping tax in Texas | test-mode registration (Klaus) |
| A Stripe webhook delivery in the pinned shape | the test-mode endpoint (ADR-0030) |
| Everything after a Printful confirmation | recorded during the go-live orders |
