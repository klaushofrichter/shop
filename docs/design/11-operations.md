# 11. Operations

Revised for review round 2 (2026-11-25): one `SHOP_MODE` with a database and a Printful
store per mode (ADR-0029), a hardened deploy runner, threshold values and host details
out of this public document (ADR-0028), metrics deferred.

## 1. Deployment

Per the cluster's rules (ADR-0016); the workflows exist since PR #2.

- `main` → image `ghcr.io/klaushofrichter/shop:main` (built on GitHub's runners, never deployed).
- Promotion PR `main` → `production` (Cluster merges) → `deploy-production.yml`: the image is built and pushed on a GitHub-hosted runner; only the **deploy job** runs on the in-cluster runner: version `YYYY.MM.DD.N`, image by digest, the kube-setup manifest updated and pushed before `kubectl apply`, rollout polled, smoke test (`/health` serves the new version, HEAD 200, home page compressed), GitHub release with "Verified at release". Then `live-check.yml` (@live e2e and Lighthouse).
- **The in-cluster runner** (Cluster, 2026-11-25: on a public repository a fork PR can request the self-hosted label): **no Docker-in-Docker** (the deploy job needs only `kubectl`, `git`, `sed`), an egress NetworkPolicy allowing only the Kubernetes API and GitHub, RBAC get/watch/patch on the one Deployment, and the repository set to **require approval for all outside contributors'** workflow runs. Klaus approves the setting; Cluster applies it.
- **Cluster's part** (one request after this design is accepted):
  - namespaces `shop` and `shop-runner`; the runner as above;
  - the Deployment: `replicas: 1`, `Recreate`, the non-root `securityContext`, readiness and liveness on `/health`, memory request 256 Mi and **limit 512 Mi** (rendering a 12 × 16 print file, 3600 × 4800 px, with `sharp.concurrency(1)` and the cache off; a test asserts peak memory below 384 MiB), CPU 0.5;
  - a 5 Gi Retain PVC; the Litestream sidecar; Ingress and Certificate for `shop.klaushofrichter.net`;
  - the NetworkPolicy below; the Secrets below; the version-exporter entry; UptimeRobot `HEAD /health`; `export.sh`/`bootstrap.sh`; Velero;
  - a ConfigMap with the fail-safe thresholds (kube-setup is private);
  - creating and protecting `production` right before the first deploy (protection approved by Klaus 2026-11-24).
- **art's part** (art's repository): the "Prints & merchandise" link driven by `/api/offers?source=art`; later, if art wants, the works feed with `printsAllowed` ([04 §4.3](04-catalog-and-print-files.md#43-the-art-adapter)).

**Secrets** are built by `scripts/create-secrets.sh` from named keys in the node's
`.env`, never the whole file, and never printed. Deploy credentials never reach the app
pod; the live Stripe key and live Printful token only at go-live.

| Secret | Keys (app variable ← `.env` key) |
|---|---|
| `shop-env` | `PRINTFUL_TOKEN` ← `PRINTFUL_TOKEN_TEST` (test) or `PRINTFUL_TOKEN` (live); `STRIPE_SECRET_KEY` ← `STRIPE_TEST_TOKEN` (test) or `STRIPE_LIVE_TOKEN` (live); `STRIPE_WEBHOOK_SECRET` and `PRINTFUL_WEBHOOK_SECRET` of that mode; `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `ALLOWED_EMAILS`, `COOKIE_SECRET`; SES credentials; `PREVIEW_KEY` (non-live) |
| `shop-litestream` | the backup bucket's access key and secret |
| runner registration | the runner's GitHub token |
| repository Actions secret | the kube-setup deploy token (Klaus) |

`--mock` puts only mock keys in `shop-env`. `--live` is refused unless `SHOP_MODE=live`
is passed too. The script prints key names and the Stripe key's prefix only.

**NetworkPolicy**, namespace `shop`, default deny: ingress from Traefik on the app port;
egress DNS, **TCP 443 to public addresses only** (the cluster's pod and service ranges
and the LAN excluded; Printful, Stripe, S3 and SES addresses change, so no host
allow-list), and art's pods on art's port.

## 2. Configuration

### 2.1 Mode (ADR-0029)

`SHOP_MODE = mock | test | live` decides everything that must agree (review 1 F25):

| | mock | test | live |
|---|---|---|---|
| Printful | the mock service | the **test store** (its own token) | the live store |
| Stripe | the mock service | Stripe test mode | Stripe live mode |
| Confirm at Printful | the mock's confirm | **never** (drafts only) | yes |
| Database file | `mock.db` | `test.db` | `live.db` |
| Customer e-mail | allow-list | allow-list | everyone |
| Preview gate, banner, `noindex`, empty `/api/offers` | yes | yes | no |
| Keys allowed | mock keys only | `rk_test_` and the test store's token | `rk_live_` and the live store's token |

At startup the process checks: the key prefixes match the mode; the Printful token's
store is the mode's store (`GET /v2/stores`) with the needed scopes; mock keys only
with mock URLs and real keys only with real hosts. Any mismatch stops the start. Going
live is one change, `SHOP_MODE=live` plus the live Secret, made by Cluster on Klaus's
word.

### 2.2 Variables

| Variable | Purpose |
|---|---|
| `SHOP_MODE` | above |
| `PUBLIC_URL`, `DATA_DIR` | the shop's address; database, files, images |
| `SOURCES_CONFIG` | path to `config/sources.json` (overridable in tests) |
| `PRINTFUL_BASE_URL`, `STRIPE_API_BASE` | set only in mock mode |
| secrets of §1 | |
| `SHIP_COUNTRIES` | `US` (ADR-0011) |
| `MARGIN_FLOOR_CENTS`, `SHIPPING_MARKUP_CENTS`, `PROVIDER_TAX_ALLOWANCE_PCT` | cost checks ([05 §2](05-quote-checkout-payment.md#2-quote), [06 §4](06-fulfilment.md#4-submission)) |
| retry window and hold deadlines per hold kind | ADR-0010 |
| fail-safe thresholds (`APPROVAL_OVER_CENTS`, `REPEAT_*`, `BREAKER_*`, order limits) | **values in kube-setup's ConfigMap**, not in this repository; required in live mode; tests use artificial values |
| `DELAY_NOTICE_HOURS`, `EMAIL_ENABLED`, `EMAIL_FROM`, `ALERT_EMAIL` | e-mail |

The process validates everything at startup and logs only which variables are present.

## 3. Backup and restore

- Litestream replicates the mode's database file continuously to a new S3 bucket (Klaus creates it; never another service's), daily snapshot, 30 days.
- Velero backs up the PVC daily (print files, images, mockups, a nightly `VACUUM INTO` copy).
- Restore test in CI (Litestream against MinIO in Docker) and once on the cluster before go-live.
- Files can be regenerated from the sources; the database can't. After a restore the reverse reconciliation **alerts** on paid sessions or provider orders without a local row ([07 §5](07-orders-data-jobs.md#5-reconciliation)); Klaus decides per alarm. It does not rebuild rows.

## 4. Observability

- Logs: JSON lines to stdout; the order id on order-related lines; no personal data, no secrets, no request bodies, **no query strings**. A test asserts the failure log printed in CI holds no personal data.
- `/health`: `{status, version}`, no dependency checks.
- Alerts by e-mail ([09 §2](09-notifications.md#2-alerts-to-klaus)). Metrics deferred: if wanted later, the cluster's Grafana Alloy scrapes annotated pods and ships allow-listed metric names (Cluster, 2026-11-25).
- The admin's System page for a human view.

## 5. Runbooks (written during implementation, operational details in the private repository)

| Situation | Outline |
|---|---|
| Rotate a Printful token | new token → `.env` → Secret → restart → re-register that store's webhook → new webhook secret |
| Rotate Stripe keys | new restricted key → `.env` → Secret → restart |
| Stripe webhook endpoints | created by Klaus in the Dashboard per mode with the pinned API version (ADR-0030) |
| Go live | checklist in [12 §4](12-testing.md#4-go-live-checklist-klaus-decides-each-box) |
| Restore the database | scale to 0 → `litestream restore` → start → reverse reconciliation alarms → Klaus decides |
| Printful or Stripe outage | nothing: quotes and Pay fail gracefully; paid orders wait and retry |
| Disable the shop quickly | disable works in the admin (art hides links within 10 minutes), or scale to 0 |
