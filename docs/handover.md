# Handover

Current state of the shop work, for whichever session picks it up next. Keep it current.

## Who's who

- **Klaus**: owner; decides everything in [ADR](adr/README.md) status Proposed, pricing, tax, legal texts, accounts and keys, DNS and exposure, cost, going live.
- **Shop - Cloud** (cloud session): owns this repo; research, design, code.
- **Cluster - Linux** (session on the cluster node, kube-setup agent): parent; repo settings, branch protection, manifests, Secrets, runner, merges `main` → `production`.
- Rules: the vault "General 2026" (read-only mirror; changes go to kube-setup `docs/vault` via Cluster) and [ADR-0016](adr/0016-follow-cluster-repository-rules.md).

## Status (2026-11-25)

- `main` holds the design set, research, ADRs 0001–0036, the skeleton service and CI. Nothing is deployed (the stage-1 skeleton deploy waits for Klaus's go in Cluster's session).
- **Design round 1**: two independent reviews, triaged in `docs/reviews/2026-11-25-triage.md`. Klaus decided (2026-11-25): a cart with any pictures (ADR-0026); customer e-mails at launch (ADR-0027); sensitive test data to a private repository without CI (ADR-0028); a Printful **test store** (ADR-0029); no unneeded personal data to third parties, consent where needed (ADR-0031); random five-digit order numbers (ADR-0032); launch sizes up to 12 × 16 in both orientations (ADR-0033); what art sells is art's decision, later.
- **Design revised for round 2** (`docs/design/`, brief in `docs/design/REVIEW-BRIEF.md`): state model with payment/fulfilment/dispute state, holds and invariants I1–I9 (ADR-0034, Proposed); content sources (ADR-0035, Proposed); local quote checks (ADR-0036, Proposed); Stripe webhook endpoints by Klaus in the Dashboard (ADR-0030, Proposed); one `SHOP_MODE` (ADR-0029, Proposed part).
- Real API behaviour captured twice on 2026-11-24 (Stripe test key; Printful reads and 3 drafts, all deleted). Raw captures move to the private repository; the public `capture/*` branches are deleted after the move.
- Cluster, 2026-11-25: on a public repository a fork PR can reach a self-hosted runner; the shop's runner will have no Docker-in-Docker, an egress policy, and the repository will require approval for all outside contributors (Klaus approves). kube-setup is private (threshold values go there). Secret scanning and push protection are on.

## Next

1. Review round 2 by independent agents; fold in; Klaus decides the Proposed ADRs.
2. `shop-private` created and the captures moved (Cluster, Klaus); then delete the public `capture/*` branches.
3. Build in the order of `docs/design/13-plan-and-open-questions.md` §1.

## Keys

Names only, in the shop's `.env` on the node: `PRINTFUL_TOKEN` (live store), `PRINTFUL_TOKEN_TEST` (test store), `STRIPE_TEST_TOKEN` (`rk_test_`), `STRIPE_LIVE_TOKEN` (`rk_live_`), the Google OAuth values, `ALLOWED_EMAILS`, `COOKIE_SECRET`, and the deploy tokens. All checked by Cluster without printing. Only test keys are used until go-live.

## Environment notes

- This cloud environment allows `*.stripe.com` and `*.printful.com` since 2026-11-24 (Klaus).
- Printful's v2 catalog requires a token; the v1 catalog (`/products/<id>`) is public.
- Vault sync: `ob sync --path /home/user/vault` (mirror-remote, download only). Credentials are in the environment; never print them.
