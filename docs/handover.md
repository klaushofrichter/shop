# Handover

Current state of the shop work, for whichever session picks it up next. Keep it current.

## Who's who

- **Klaus**: owner; decides everything in [ADR](adr/README.md) status Proposed, pricing, tax, legal texts, accounts and keys, DNS and exposure, cost, going live.
- **Shop - Cloud** (cloud session): owns this repo; research, design, code.
- **Cluster - Linux** (session on the cluster node, kube-setup agent): parent; repo settings, branch protection, manifests, Secrets, runner, merges `main` → `production`.
- Rules: the vault "General 2026" (read-only mirror; changes go to kube-setup `docs/vault` via Cluster) and [ADR-0016](adr/0016-follow-cluster-repository-rules.md).

## Status (2026-11-24)

- PR #1 (design, research, ADRs) and PR #2 (repo baseline, skeleton, CI) merged to `main`. CI: `test`, `codeql`, `e2e` (browsers in Playwright's image; the apt install timed out on a slow mirror).
- Real API behaviour captured twice on 2026-11-24 (Stripe test key; Printful reads and 3 drafts, all deleted; nothing ordered): `docs/research/api-capture-findings.md`, branches `capture/2026-11-24`, `capture/2026-11-24b`. Three capture files remain in Printful's file library.
- **Design set** for the review by Fable 5.2 on 2026-11-25: `docs/design/` (13 documents), research in `docs/research/` including `process-alternatives.md` (build vs Shopify/Quick Stores). Branch `docs/design-set`, PR #3.
- Klaus's minimum requirements (2026-11-24): one picture → one or more products → address → quote (with Printful previews) → Stripe → Printful → tracking; customer emails optional; a handful of predefined SKUs; thin provider abstraction; fully automated, < 10 orders a week.
- ADRs 0001–0024 all Accepted (2026-11-24: 0010, 0011, 0012 sales tax via Stripe Tax, 0015 Amazon SES, 0020 fail-safes, 0023, 0024 mock services). None Proposed.
- `production` branch protection approved by Klaus (2026-11-24): required `test`, `codeql`, `e2e`; strict; no force push or deletion; owner override. The branch does **not** exist yet: Cluster creates it from `main` and protects it right before the first real deploy (creating it triggers `deploy-production`). **Never create `production` from this session**; include it in the deploy request.
- Klaus allowed a test deploy (2026-11-24) on condition that **no transaction with a real service and no Printful order** happens: deploy the skeleton now; later the shop only in mock mode (no real keys in the pod) until he says otherwise.

## Next

1. **Design review** by a separate agent: brief in `docs/design/REVIEW-BRIEF.md`; it writes `docs/reviews/2026-11-25-design-review.md` in its own PR. Fold the findings into `docs/design/` and record changed decisions as ADRs.
2. ~~ADR-0025~~ accepted 2026-11-24: originals come from art's public URLs; ADR-0006 superseded; art's only change is the shop link.
3. Build in the order of `docs/design/13-plan-and-open-questions.md` §1: database/jobs/config, then the **mock services** with replay verification against `capture/2026-11-24` and `capture/2026-11-24b`, then the shop.
4. Stage-1 test deploy of the skeleton waits for Klaus's go in Cluster's session (exposure).
5. Klaus, before go-live: prices; seller's permit + Stripe Tax registration + Printful resale certificate; SES domain records; S3 bucket; legal texts.

## Keys

- `PRINTFUL_TOKEN`: store-level, created 2026-11-24.
- `STRIPE_TEST_TOKEN` (`rk_test_`) and `STRIPE_LIVE_TOKEN` (`rk_live_`), checked by prefix only (2026-11-24). Only the test key is used until go-live. Permissions: docs/design/05 §8 (includes Customers write).
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (rotated 2026-11-24 after an exposure in Cluster's transcript; old one revoked), `GOOGLE_REDIRECT_URI`, `ALLOWED_EMAILS`, `COOKIE_SECRET`: checked by Cluster without printing.

## Environment notes

- This cloud environment allows `*.stripe.com` and `*.printful.com` since 2026-11-24 (Klaus).
- Printful's v2 catalog requires a token; the v1 catalog (`/products/<id>`) is public.
- Vault sync: `ob sync --path /home/user/vault` (mirror-remote, download only). Credentials are in the environment; never print them.
