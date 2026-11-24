# 11. Operations

## 1. Deployment

Per the cluster's rules (ADR-0016); the workflows exist since PR #2.

- `main` → image `ghcr.io/klaushofrichter/shop:main` (never deployed).
- Promotion PR `main` → `production` (Cluster merges) → `deploy-production.yml` on the in-cluster runner: version `YYYY.MM.DD.N`, image by digest, kube-setup manifest `manifests/shop/shop-deployment.yaml` updated and pushed before `kubectl apply`, rollout polled, smoke test (`/health` serves the new version, HEAD 200, home page compressed), GitHub release with "Verified at release". Then `live-check.yml` runs the @live e2e tests and Lighthouse against the live site.
- **Cluster's part** (one request when implementation starts): namespaces `shop` and `shop-runner`; runner with RBAC on the one Deployment; the Deployment (`replicas: 1`, `Recreate`, the non-root `securityContext`, readiness and liveness on `/health`, memory request 256 Mi / **limit 512 Mi**, CPU 0.5: an OOM kill in the middle of a webhook is worse than headroom; the largest SKU (16×20 at 300 DPI, 4800 × 6000 px ≈ 115 MB as raw RGBA) renders with libvips streaming, `sharp.concurrency(1)` and the cache off, and the print-file test measures peak RSS so a larger SKU can't silently exceed the limit); a 5 Gi Retain PVC; Litestream sidecar; Ingress + Certificate for `shop.klaushofrichter.net` with HTTP→HTTPS; the NetworkPolicy below; the Secrets below; version-exporter entry; UptimeRobot `HEAD /health`; namespaces in `export.sh`/`bootstrap.sh`; Velero coverage; and creating and protecting the `production` branch right before the first deploy (Klaus approved the protection 2026-11-24: required `test`, `codeql`, `e2e`, strict, no force push or deletion, owner override).
- **art's part** (art's repo, its owner session): the "Prints & merchandise" link driven by `GET shop…/api/offers`. Nothing else: the shop reads originals from art's existing public URLs (ADR-0025).

**Secrets.** The node's `.env` is not copied as a whole: it also holds deploy credentials
(`SHOP_GITHUB_PAT`, `GITHUB_KUBE_SETUP_PAT`) that must never reach the app pod, and
`STRIPE_LIVE_TOKEN`, which the app gets only at go-live. A repo script
`scripts/create-secrets.sh` (pattern: cams-admin's), run on the node by Cluster or Klaus,
builds each Secret from named keys only and never prints a value:

| Secret | Keys (app variable ← `.env` key) |
|---|---|
| `shop-env` (namespace `shop`) | `PRINTFUL_TOKEN`; `STRIPE_SECRET_KEY` ← `STRIPE_TEST_TOKEN` in test mode, ← `STRIPE_LIVE_TOKEN` only with `--live` (Klaus's go); `STRIPE_WEBHOOK_SECRET` (of that mode); `PRINTFUL_WEBHOOK_SECRET`; `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `ALLOWED_EMAILS`, `COOKIE_SECRET`; email credentials once chosen |
| `shop-litestream` (namespace `shop`) | the backup bucket's access key and secret |
| `runner-pat` (namespace `shop-runner`) | `SHOP_GITHUB_PAT` (runner registration) |
| Actions secret `KUBE_SETUP_DEPLOY_TOKEN` (repo) | `GITHUB_KUBE_SETUP_PAT`, set by Klaus |

With `--mock` the script puts **only mock keys** in `shop-env` (no real Stripe key, no real Printful token): the configuration for every test deployment until Klaus allows more. The script refuses `--live` unless `STRIPE_MODE=live` is also passed, prints only key
names and the Stripe key's prefix (`rk_test_`/`rk_live_`), and exits non-zero on a
missing key.

**NetworkPolicy** (pattern: cams-admin, games), namespace `shop`, default deny both ways:
- ingress: from Traefik (namespace `kube-system`, Traefik pods) on the app port; from the cluster's metrics scraper on `/metrics`, if used;
- egress: DNS (kube-dns, UDP/TCP 53); **TCP 443 to `0.0.0.0/0` except `10.42.0.0/16`, `10.43.0.0/16` and `192.168.1.0/24`** (Printful, Stripe, S3, email: their CDN addresses change, so no allow-list by hostname); art's pods in namespace `art` on art's port (manifest and originals);
- art's namespace allows ingress from namespace `shop` to that port.

## 2. Configuration

Environment variables (Kubernetes Secret `shop-env` for secrets, ConfigMap for the rest). The process validates all of them at startup and logs which are present (names only); a missing required one stops the start in live mode.

| Variable | Secret | Purpose |
|---|---|---|
| `PUBLIC_URL` | | `https://shop.klaushofrichter.net` |
| `DATA_DIR` | | `/var/lib/shop` (database, files, mockups) |
| `ART_URL`, `ART_CLUSTER_URL` | | `https://art.klaushofrichter.net/` (links), `http://art.art.svc.cluster.local/` (manifest and originals, in-cluster) |
| `PRINTFUL_BASE_URL`, `STRIPE_API_BASE` | | real API hosts, or the mock service in mock mode ([14 §3](14-mock-services.md#3-selecting-mocks-in-the-shop)) |
| `SHADOW_PRINTFUL`, `SHADOW_STRIPE` | | off by default; `readonly` / `test` turn on shadow comparison ([14 §7.3](14-mock-services.md#7-verification-against-the-real-services)) |
| `PRINTFUL_TOKEN` | yes | Printful store-level token |
| `PRINTFUL_WEBHOOK_SECRET`, `PRINTFUL_WEBHOOK_PUBLIC_KEY` | yes / no | from webhook registration |
| `FULFILMENT_CONFIRM` | | `false` (drafts only) until go-live |
| `STRIPE_MODE` | | `test` until go-live |
| `STRIPE_SECRET_KEY` | yes | the restricted key of the current mode (built from `STRIPE_TEST_TOKEN` or, at go-live, `STRIPE_LIVE_TOKEN`; see Secrets above) |
| `STRIPE_WEBHOOK_SECRET` | yes | that mode's endpoint secret |
| `TAX_ENABLED` | | ADR-0012 |
| `SHIP_COUNTRIES` | | `US` (ADR-0011) |
| `MARGIN_FLOOR_CENTS`, `SHIPPING_MARKUP_CENTS` | | cost guard, markup |
| `RETRY_WINDOW_HOURS`, `HOLD_REFUND_HOURS`, `ATTENTION_REFUND_HOURS` | | 24, 72, 24 (ADR-0010) |
| `LIMIT_ITEM_QTY`, `LIMIT_ITEMS`, `LIMIT_ORDER_CENTS` | | 10 (postcards 25 in the SKU config), 20, 50000 (ADR-0020) |
| `APPROVAL_OVER_CENTS`, `APPROVAL_REFUND_HOURS` | | 25000, 72 |
| `BREAKER_ORDERS_24H`, `BREAKER_COST_CENTS_24H` | | 10, 60000 |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `ALLOWED_EMAILS`, `COOKIE_SECRET` | yes (all but the URI) | admin sign-in |
| `EMAIL_ENABLED`, `EMAIL_FROM`, provider credentials | creds yes | ADR-0015 |
| `ALERT_EMAIL` | | where alerts go |

**Live-mode guard**: the process refuses to start if `STRIPE_MODE=live` and
`FULFILMENT_CONFIRM=false`, or the reverse, since a mixed mode would either take money
without producing or produce without taking money. Going live = Klaus sets both and
the Cluster session applies the change. The admin shows a permanent TEST banner
otherwise, and test orders are marked `mode=test`.

The node's `.env` (`~/Development/shop/.env`, mode 600) is the source; names today:
`PRINTFUL_TOKEN`, `STRIPE_LIVE_TOKEN`, `STRIPE_TEST_TOKEN`, `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `COOKIE_SECRET`, `ALLOWED_EMAILS`
(plus the deploy tokens `SHOP_GITHUB_PAT`, `GITHUB_KUBE_SETUP_PAT`). Still needed:
the webhook secrets (from registration), the S3
credentials (new bucket and IAM user, Klaus), the email provider's.

## 3. Backup and restore

- **Litestream** sidecar: continuous WAL replication of `shop.db` to `s3://<new bucket>/shop/` (bucket and IAM user created by Klaus; never cams-admin's); snapshot daily, retention 30 days.
- **Velero**: daily file-system backup of the PVC (print files, mockups, a `VACUUM INTO` copy of the database written nightly by the `purge` job).
- **Restore test** in CI (as cams-admin): Litestream against MinIO in Docker, restore, compare. And once on the cluster before going live.
- Print files and mockups can be regenerated from art's originals; the database cannot (it is also partly reconstructible from Stripe and Printful, which both hold every paid order with our id).
- Alarm: replication lag > 2 h ([07 §5](07-orders-data-jobs.md#5-reconciliation)); the cluster's backup dead-man alert extended to the new bucket (Cluster).

## 4. Observability

- Logs: JSON lines (pino) to stdout, collected by the cluster's log pipeline; order id on every order-related line; no PII beyond the order id, no secrets, no request bodies.
- `/health`: `{status, version}` (unauthenticated, no dependencies checked so it never flaps on Printful).
- `/metrics` (Prometheus text, cluster-internal only): `shop_orders{state}`, `shop_jobs{kind,state}`, `shop_alarms`, `shop_webhook_failures_total{provider}`, `shop_litestream_lag_seconds`, `shop_printful_ratelimit_remaining`. *(Verify with Cluster how the cluster scrapes and alerts; the vault names Grafana Cloud.)*
- Admin System page ([08 §3](08-admin.md#3-pages)) for a human view.

## 5. Runbooks (in `docs/runbooks/`, written during implementation)

| Situation | Steps (outline) |
|---|---|
| Rotate the Printful token | New token in Printful → `.env` → Cluster updates the Secret → restart → re-register the webhook (the config is per token) → update `PRINTFUL_WEBHOOK_SECRET`. |
| Rotate Stripe keys | New restricted key → `.env` → Secret → restart. Webhook secrets unchanged. |
| Go live | Checklist in [12 §4](12-testing.md#4-test-mode-and-go-live). |
| Restore the database | Stop the Deployment (scale 0) → `litestream restore` to the PVC → start → reconciliation catches up from Stripe and Printful. |
| Printful outage | Nothing: quotes fail gracefully, paid orders wait in `paid` and are retried for 24 h. |
| Stripe outage | Nothing: Pay fails gracefully. |
| Disable the shop quickly | Set all pictures disabled in the admin (art hides links in ≤ 10 min), or scale to 0 (art's links then hit an error page: also hide them via `/api/offers` being unreachable → art shows no link). |
