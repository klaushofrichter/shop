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
- **Step 4 in progress**: (a) sign-in (state, PKCE, nonce; HMAC session; CSRF and same-origin on every change; ALLOWED_EMAILS on every request), dashboard, works list with enable/disable and an audit row; admin e2e with a minted cookie. Next: (b) the work page with offers, prices, anchors and print files; (c) mockups.

## Next

1. Build in the order of `docs/design/13-plan-and-open-questions.md` §1, starting with step 2.

## Keys

Names only, in the shop's `.env` on the node: `PRINTFUL_TOKEN` (live store), `PRINTFUL_TOKEN_TEST` (test store), `STRIPE_TEST_TOKEN` (`rk_test_`), `STRIPE_LIVE_TOKEN` (`rk_live_`), the Google OAuth values, `ALLOWED_EMAILS`, `COOKIE_SECRET`, and the deploy tokens. Still to add when their step comes: `STATUS_TOKEN_SECRET` (step 8), the webhook secrets and Printful's webhook public key (step 10), `PREVIEW_KEY` (step 9), the SES credentials (step 8); see `.env.example`. All checked by Cluster without printing. Only test keys are used until go-live.

## Environment notes

- This cloud environment allows `*.stripe.com` and `*.printful.com` since 2026-11-24 (Klaus).
- Printful's v2 catalog requires a token; the v1 catalog (`/products/<id>`) is public.
- Vault sync: `ob sync` into the session's vault mirror (mirror-remote, download only). Credentials are in the environment; never print them.
