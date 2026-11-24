# 11. Operations

## 1. Deployment

Per the cluster's rules (ADR-0016); the workflows exist since PR #2.

- `main` → image `ghcr.io/klaushofrichter/shop:main` (never deployed).
- Promotion PR `main` → `production` (Cluster merges) → `deploy-production.yml` on the in-cluster runner: version `YYYY.MM.DD.N`, image by digest, kube-setup manifest `manifests/shop/shop-deployment.yaml` updated and pushed before `kubectl apply`, rollout polled, smoke test (`/health` serves the new version, HEAD 200, home page compressed), GitHub release with "Verified at release". Then `live-check.yml` runs the @live e2e tests and Lighthouse against the live site.
- **Cluster's part** (one request when implementation starts): namespaces `shop` and `shop-runner`; runner with RBAC on the one Deployment; the Deployment (`replicas: 1`, `Recreate`, the non-root `securityContext`, readiness and liveness on `/health`, resources ~256 Mi / 0.5 CPU, `sharp` peaks ~400 Mi while rendering a 16×20 file); a 5 Gi Retain PVC; Litestream sidecar; Ingress + Certificate for `shop.klaushofrichter.net` with HTTP→HTTPS; NetworkPolicy; Secrets; version-exporter entry; UptimeRobot `HEAD /health`; namespaces in `export.sh`/`bootstrap.sh`; Velero coverage.
- **art's part** (art's repo, its owner session): the "Prints & merchandise" link driven by `GET shop…/api/offers`; `GET /internal/originals/<uid>` with a bearer token; `/internal` blocked on art's public route (Traefik rule, kube-setup).

## 2. Configuration

Environment variables (Kubernetes Secret `shop-env` for secrets, ConfigMap for the rest). The process validates all of them at startup and logs which are present (names only); a missing required one stops the start in live mode.

| Variable | Secret | Purpose |
|---|---|---|
| `PUBLIC_URL` | | `https://shop.klaushofrichter.net` |
| `DATA_DIR` | | `/var/lib/shop` (database, files, mockups) |
| `ART_URL`, `ART_INTERNAL_URL` | | `https://art.klaushofrichter.net/`, `http://art.art.svc.cluster.local` |
| `ART_INTERNAL_TOKEN` | yes | originals endpoint |
| `PRINTFUL_TOKEN` | yes | Printful store-level token |
| `PRINTFUL_WEBHOOK_SECRET`, `PRINTFUL_WEBHOOK_PUBLIC_KEY` | yes / no | from webhook registration |
| `FULFILMENT_CONFIRM` | | `false` (drafts only) until go-live |
| `STRIPE_MODE` | | `test` until go-live |
| `STRIPE_TEST_TOKEN`, `STRIPE_LIVE_TOKEN` | yes | restricted keys |
| `STRIPE_TEST_WEBHOOK_SECRET`, `STRIPE_LIVE_WEBHOOK_SECRET` | yes | endpoint secrets |
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
`ART_INTERNAL_TOKEN` (generated), the webhook secrets (from registration), the S3
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
