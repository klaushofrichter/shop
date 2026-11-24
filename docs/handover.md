# Handover

Current state of the shop work, for whichever session picks it up next. Keep it current.

## Who's who

- **Klaus**: owner; decides everything in [ADR](adr/README.md) status Proposed, pricing, tax, legal texts, accounts and keys, DNS and exposure, cost, going live.
- **Shop - Cloud** (cloud session): owns this repo; research, design, code.
- **Cluster - Linux** (session on the cluster node, kube-setup agent): parent; repo settings, branch protection, manifests, Secrets, runner, merges `main` → `production`.
- Rules: the vault "General 2026" (read-only mirror; changes go to kube-setup `docs/vault` via Cluster) and [ADR-0016](adr/0016-follow-cluster-repository-rules.md).

## Status (2026-11-24)

- Done: research (Printful, Stripe, open-source projects), [design.md](design.md), ADRs 0001–0021 and research/oss-learnings.md on branch `docs/design` (PR #1 to `main`). No service code.
- Accepted: ADR-0001 (keep ADRs), ADR-0005 (Printful API v2), ADR-0016 (follow the cluster rules), and group 1 on 2026-11-24: 0002, 0003, 0004, 0006, 0009, 0013, 0014, 0018, 0019.
- Still Proposed: group 2 (before checkout works: 0007, 0008, 0010, 0017, 0020, 0021) and group 3 (before going live: 0011, 0012, 0015). Plan: decide group 2 one at a time while the skeleton is built; group 3 once the shop works end to end in Stripe test mode.
- Cluster agreed: separate service; originals via an internal art endpoint with a mandatory token and `/internal` blocked on art's public route; SQLite + Litestream to a new bucket + Velero.

## Next

1. ~~Merge PR #1 (docs)~~ (merged 2026-11-24).
2. Repo baseline and skeleton service (design.md §13 step 1–2): PR `chore/repo-baseline`. After its CI is green, ask Cluster for `production` branch protection (required: test, codeql, e2e; needs Klaus's OK).
3. Klaus: ~~Printful private token~~ (created 2026-11-24, in the node's `.env`; probed read-only with `scripts/printful-probe.sh` run by Cluster), Stripe restricted key and webhook secret (test mode first), Google OAuth client, S3 bucket + IAM user, email provider. Values go into `~/Development/shop/.env` on the node, never into chat or git.

## Exposure

- 2026-11-24: Klaus configured DNS. `shop.klaushofrichter.net` resolves to the cluster's public IP (same as art). Nothing serves it yet: no Ingress, Certificate or service. Those come with the first deploy, made by Cluster.

## Keys

- `PRINTFUL_TOKEN`: store-level, created 2026-11-24.
- `STRIPE_TOKEN`: a restricted key in **live** mode (`rk_live_`, checked by prefix only, 2026-11-24). Not used for development; a test-mode restricted key is needed (asked of Klaus).

## Environment notes

- This cloud environment allows `*.stripe.com` and `*.printful.com` since 2026-11-24 (Klaus).
- Printful's v2 catalog requires a token; the v1 catalog (`/products/<id>`) is public.
- Vault sync: `ob sync --path /home/user/vault` (mirror-remote, download only). Credentials are in the environment; never print them.
