# 11. Operations

## 1. Deployment

Per the cluster's rules (ADR-0016); the workflows exist since PR #2.

- `main` → image `ghcr.io/klaushofrichter/shop:main` (never deployed).
- Promotion PR `main` → `production` (Cluster merges) → `deploy-production.yml` on the in-cluster runner: version `YYYY.MM.DD.N`, image by digest, kube-setup manifest `manifests/shop/shop-deployment.yaml` updated and pushed before `kubectl apply`, rollout polled, smoke test (`/health` serves the new version, HEAD 200, home page compressed), GitHub release with "Verified at release". Then `live-check.yml` runs the @live e2e tests and Lighthouse against the live site.
- **Cluster's part** (one request when implementation starts): namespaces `shop` and `shop-runner`; runner with RBAC on the one Deployment; the Deployment (`replicas: 1`, `Recreate`, the non-root `securityContext`, readiness and liveness on `/health`, memory request 256 Mi / **limit 512 Mi**, CPU 0.5: an OOM kill in the middle of a webhook is worse than headroom; the largest SKU (16×20 at 300 DPI, 4800 × 6000 px ≈ 115 MB as raw RGBA) renders with libvips streaming, `sharp.concurrency(1)` and the cache off, and the print-file test measures peak RSS so a larger SKU can't silently exceed the limit); a 5 Gi Retain PVC; Litestream sidecar; Ingress + Certificate for `shop.klaushofrichter.net` with HTTP→HTTPS; the NetworkPolicy below; the Secrets below; version-exporter entry; UptimeRobot `HEAD /health`; namespaces in `export.sh`/`bootstrap.sh`; Velero coverage; and creating and protecting the `production` branch right before the first deploy (Klaus approved the protection 2026-11-24: required `test`, `codeql`, `e2e`, strict, no force push or deletion, owner override).
- **art's part** (art's repo, its owner session): the "Prints & merchandise" link driven by `GET shop…/api/offers`. Nothing else: the shop reads originals from art's existing public URLs (ADR-0025).
