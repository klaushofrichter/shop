# Handover

Current state of the shop work, for whichever session picks it up next. Keep it current.

## Who's who

- **Klaus**: owner; decides everything in [ADR](adr/README.md) status Proposed, pricing, tax, legal texts, accounts and keys, DNS and exposure, cost, going live.
- **Shop - Cloud** (cloud session): owns this repo; research, design, code.
- **Cluster - Linux** (session on the cluster node, kube-setup agent): parent; repo settings, branch protection, manifests, Secrets, runner, merges `main` → `production`.
- Rules: the vault "General 2026" (read-only mirror; changes go to kube-setup `docs/vault` via Cluster) and [ADR-0016](adr/0016-follow-cluster-repository-rules.md).

## Status (2026-11-26)

- `main` holds the design set, research, ADRs 0001–0039, the skeleton service and CI. Nothing is deployed.
- **Design round 1**: two reviews, triaged in `docs/reviews/2026-11-25-triage.md`; Klaus's decisions are ADR-0026 to ADR-0033.
- **Design round 2**: four reviews (A, B, C, D), triaged in `docs/reviews/2026-11-26-triage-round-2.md` (addendum for C and D at its end) and folded into `docs/design` and the ADRs on 2026-11-26. **The design is frozen; no third round.**
  - Klaus decided 2026-11-26: test mode only before go-live and mock mode only in CI, so the first cluster deployment talks to Stripe test mode and makes drafts in the test store (ADR-0029); status links from `STATUS_TOKEN_SECRET` (ADR-0037); SES bounces forwarded by e-mail (ADR-0038); go-live behind the preview gate with Printful-only recording (ADR-0039).
  - Klaus accepted the rest the same day ("decisions 1, 2, 4, 6, 7, 8, 9: ok"): ADR-0034, ADR-0029 in full (shared catalog file), ADR-0030, ADR-0035, ADR-0036, the amendment of ADR-0010 and the note on ADR-0020, a shop contact address on the packing slip. **No ADR is Proposed.** Still to name: the shop's orders address (step 7).
  - For Cluster: runner hardening (triage §4 and 11 §1), the Knative egress question, the deploy token as an environment secret.
- Real API behaviour captured twice on 2026-11-24; raw captures in the private repository `shop-private` (no CI). The capture script now reads only the test-store token and refuses to write inside this repository.
- Cluster, 2026-11-25: a fork PR can reach a self-hosted runner on a public repository; the shop's runner gets no Docker-in-Docker and the repository requires approval for outside contributors. kube-setup is private (threshold values and store ids go there). Secret scanning and push protection are on.

- **Step 2 done** (PR #12): configuration and mode checks, SKU and source files, both database files with migrations, the `Clock`, the job runner and `/health/worker`.
- **Step 3** (PR #13): the art adapter (contract test against a recorded manifest), works in `catalog.db`, original checks by SHA-256 and display images (`/img/*`); the Printful adapter (identity, catalog, shipping rates, file library) with startup verification (wrong answer stops the start, no answer doesn't), the daily SKU check, print-file registration and `/files/*`; mock Printful stage 1 (`mocks/printful/`) with request validation against the pinned v2 spec.
- **Step 4** (PRs #14, #15): sign-in, dashboard, works, the work page with offers, prices, anchors and readiness; print files rendered and registered at Printful; mockups (one task per 30 s, stored without metadata, the display image standing in until then).

- **Step 5** (PRs #16, #17): preview gate, picture pages, cart, `/api/offers`; address form with the ZIP ↔ state table, the quote (one Printful call) with the pre-payment cost check.
- **Step 6 done**: (a) Stripe client, webhook signatures, mock Stripe (PR #18); (b) `/checkout`, orders, the payment transaction with the fail-safes, the Stripe webhook and event job, the order status page, find my order (PR #19); (c) the mocks as one process (`mocks/server.ts`: mock Printful, mock Stripe, a fake art), the mock-mode passthrough of `/__mock-pages/stripe/`, and a browser e2e of a whole purchase in CI (`e2e/purchase.spec.ts`: enable a work, offer a print, buy it, see it paid).
- **Step 7 in progress**: (a) submission (`src/orders/submit.ts`): preconditions I2, attempt claim, look-up before create, draft, costs, cost guard, test-mode stop, confirm with a fresh Stripe refund read and the quiet period (I3); mock Printful orders (draft, costs, confirm, v2 delete, v1 cancel, lost-answer scenarios); new hold reasons `provider_refused`, `costs_failed`, `provider_failed`, `confirm_failed`. (b) Printful webhooks (`src/orders/fulfilment-events.ts`): verification, stored once with the raw body, re-fetch, newest attempt only, provider holds and their removal, Printful's own cancel and failure as attention holds, shipments with tracking on the order page, an e-mail job per parcel, delivered → complete; mock Printful sends signed webhooks and ships. (c) refunds, deadlines, disputes (`src/orders/refunds.ts`): refunds as a row first, then Stripe, then the charge decides; Dashboard refunds recorded; full refund → holds resolved, I7 cancel, completion; hold deadlines with the I4 proof (delete drafts, never while disputed; otherwise the hold becomes an alert), alerts repeated daily; early fraud warnings (refund at once before production, cancel then refund after confirm, alert in production) and disputes (never a refund; lost completes). (d) the admin's orders (`src/admin/orders.ts`): the list with search, the order page (amounts with Stripe's fee and Printful's cost, holds with time to deadline, refunds, attempts, shipments, history, dashboard links), the dashboard's open holds, and the actions approve, false alarm, confirm anyway, retry refund, fulfil anyway, refund, refund anyway, cancel at Printful, retry submission, reset the breaker; each needs "I'm sure" and goes to `admin_audit`. (e) reconciliation (`src/orders/reconcile.ts`, hourly and "run now" on the dashboard): open checkouts, unchecked or idle paid orders, re-fetch of confirmed orders and their shipments, completion `COMPLETE_AFTER_SHIPPED_DAYS` (45) after shipping, confirms past the quiet period, refunds made elsewhere, deadlines, stuck inbound events, I10; reverse pass over Printful's last 100 orders and Stripe's paid sessions of 7 days (alarms, never new rows); `/health/worker` checks it. Purge (`src/orders/purge.ts`, nightly) per 07 §6. **Step 7 done**; e-mails and alerts (step 8) next.

## Waiting for Klaus

- Retail prices per product (`config/skus.json`; the current ones are placeholders and a live start refuses them).
- The return address in Printful's store settings (the packing slip itself carries only an e-mail, a phone, a message and a logo).

## Settled on 2026-11-25

- Every work of art, every product (ADR-0040); prices per product.
- Packing-slip contact: Klaus gave the e-mail and phone. They go into the cluster's configuration (`PACKING_SLIP_EMAIL`, `PACKING_SLIP_PHONE`), not into this public repository.
- `STATUS_TOKEN_SECRET` is in the node's `.env` (Cluster). `scripts/create-secrets.sh` (step 9) must list it for `shop-env`.

## Next

1. Step 8 (customer e-mails and alerts via SES) in the order of `docs/design/13-plan-and-open-questions.md` §1.

## Keys

Names only, in the shop's `.env` on the node: `PRINTFUL_TOKEN` (live store), `PRINTFUL_TOKEN_TEST` (test store), `STRIPE_TEST_TOKEN` (`rk_test_`), `STRIPE_LIVE_TOKEN` (`rk_live_`), the Google OAuth values, `ALLOWED_EMAILS`, `COOKIE_SECRET`, and the deploy tokens. Still to add when their step comes: `STATUS_TOKEN_SECRET` (step 8), the webhook secrets and Printful's webhook public key (step 10), `PREVIEW_KEY` (step 9), the SES credentials (step 8); see `.env.example`. All checked by Cluster without printing. Only test keys are used until go-live.

## Environment notes

- This cloud environment allows `*.stripe.com` and `*.printful.com` since 2026-11-24 (Klaus).
- Printful's v2 catalog requires a token; the v1 catalog (`/products/<id>`) is public.
- Vault sync: `ob sync` into the session's vault mirror (mirror-remote, download only). Credentials are in the environment; never print them.
