# Handover

Current state of the shop work, for whichever session picks it up next. Keep it current.

## Who's who

- **Klaus**: owner; decides everything in [ADR](adr/README.md) status Proposed, pricing, tax, legal texts, accounts and keys, DNS and exposure, cost, going live.
- **Shop - Cloud** (cloud session): owns this repo; research, design, code.
- **Cluster - Linux** (session on the cluster node, kube-setup agent): parent; repo settings, branch protection, manifests, Secrets, runner, merges `main` → `production`.
- Rules: the vault "General 2026" (read-only mirror; changes go to kube-setup `docs/vault` via Cluster) and [ADR-0016](adr/0016-follow-cluster-repository-rules.md).

## Status (2026-11-24)

- PR #1 (design, research, ADRs) and PR #2 (repo baseline, skeleton, CI) merged to `main`. CI: `test`, `codeql`, `e2e` (browsers in Playwright's image; the apt install timed out on a slow mirror).
- **Design set** for the review by Fable 5.2 on 2026-11-25: `docs/design/` (13 documents), research in `docs/research/` including `process-alternatives.md` (build vs Shopify/Quick Stores). Branch `docs/design-set`, PR #3.
- Klaus's minimum requirements (2026-11-24): one picture → one or more products → address → quote (with Printful previews) → Stripe → Printful → tracking; customer emails optional; a handful of predefined SKUs; thin provider abstraction; fully automated, < 10 orders a week.
- ADRs: Accepted 0001–0009, 0013, 0014, 0016–0019, 0021, 0022. Accepted 0020 (fail-safes against large or unusual orders, reshaped 2026-11-24). Proposed: 0010, 0011, 0012, 0015, 0023.
- `production` branch protection approved by Klaus (2026-11-24): required `test`, `codeql`, `e2e`; strict; no force push or deletion; owner override. The branch does **not** exist yet: Cluster creates it from `main` and protects it right before the first real deploy (creating it triggers `deploy-production`). **Never create `production` from this session**; include it in the deploy request.
- No deploy request yet (after the design review).

## Next

1. Design review (2026-11-25), then fold its findings into `docs/design/` and the ADRs.
2. Implementation in the order of `docs/design/13-plan-and-open-questions.md` §1.
3. Klaus: decisions in that document's §2; S3 bucket + IAM user; prices; legal texts.

## Keys

- `PRINTFUL_TOKEN`: store-level, created 2026-11-24.
- `STRIPE_TEST_TOKEN` (`rk_test_`) and `STRIPE_LIVE_TOKEN` (`rk_live_`), checked by prefix only (2026-11-24). Only the test key is used until go-live. Permissions: docs/design/05 §8 (includes Customers write).
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (rotated 2026-11-24 after an exposure in Cluster's transcript; old one revoked), `GOOGLE_REDIRECT_URI`, `ALLOWED_EMAILS`, `COOKIE_SECRET`: checked by Cluster without printing.

## Environment notes

- This cloud environment allows `*.stripe.com` and `*.printful.com` since 2026-11-24 (Klaus).
- Printful's v2 catalog requires a token; the v1 catalog (`/products/<id>`) is public.
- Vault sync: `ob sync --path /home/user/vault` (mirror-remote, download only). Credentials are in the environment; never print them.
