# 11. Operations

Revised for review round 2 (2026-11-25): one `SHOP_MODE` with a database and a Printful
store per mode (ADR-0029), a hardened deploy runner, threshold values and host details
out of this public document (ADR-0028), metrics deferred. Round 2 fold-in (2026-11-26):
a shared catalog file, mock mode only in CI, the preview gate as its own switch, a
worker health check, a start without Printful.

## 1. Deployment

Per the cluster's rules (ADR-0016); the workflows exist since PR #2.

- `main` → image `ghcr.io/klaushofrichter/shop:main` (built on GitHub's runners, never deployed).
- Promotion PR `main` → `production` (Cluster merges) → `deploy-production.yml`: the image is built and pushed on a GitHub-hosted runner; only the **deploy job** runs on the in-cluster runner: version `YYYY.MM.DD.N`, image by digest, the kube-setup manifest updated and pushed before `kubectl apply`, rollout polled, smoke test (`/health` serves the new version, HEAD 200, home page compressed), GitHub release with "Verified at release". Then `live-check.yml` (@live e2e and Lighthouse).
- **The in-cluster runner** (Cluster, 2026-11-25: on a public repository a fork PR can request the self-hosted label): **no Docker-in-Docker** (the deploy job needs only `kubectl`, `git`, `sed`), and the repository set to **require approval for all outside contributors'** workflow runs (Klaus approves the setting; Cluster applies it). Round 2 (review B F9, review C F20) adds, for Cluster to decide and build:
  - `kubectl` baked into the runner image (no download step, no `sudo`); an ephemeral runner;
  - the smoke test from a GitHub-hosted job (it needs only the public URL), or egress to the shop's Ingress; the egress allow-list derived from GitHub's documented runner hosts;
  - an admission policy on namespace `shop` that lets the runner change only the image digest of the shop's Deployment (patch on a Deployment otherwise reaches every Secret in the namespace), or the cluster applies kube-setup's manifest and the runner only pushes to kube-setup;
  - the kube-setup deploy token as an **environment secret** of a GitHub environment `production` limited to the `production` branch, with the deploy job naming `environment: production`, so a job from any other ref never receives it (Cluster agrees, 2026-11-26; Klaus to approve).
- **Cluster's part** (one request after this design is accepted):
  - namespaces `shop` and `shop-runner`; the runner as above;
  - the Deployment: `replicas: 1`, `Recreate`, the non-root `securityContext`, readiness and liveness on `/health`, memory request 256 Mi and **limit 512 Mi** (rendering a 12 × 16 print file, 3600 × 4800 px, with `sharp.concurrency(1)` and the cache off; a test asserts peak memory below 384 MiB), CPU 0.5;
  - a 5 Gi Retain PVC; the Litestream sidecar (two database files); Ingress and Certificate for `shop.klaushofrichter.net`;
  - the NetworkPolicy below; the Secrets below; the version-exporter entry; UptimeRobot `HEAD /health` and `GET /health/worker`; `export.sh`/`bootstrap.sh`; Velero;
  - a ConfigMap with the fail-safe thresholds (kube-setup is private);
  - creating and protecting `production` right before the first deploy (protection approved by Klaus 2026-11-24).
- **art's part** (art's repository): the "Prints & merchandise" link driven by `/api/offers?source=art`; later, if art wants, the works feed with `printsAllowed` ([04 §4.3](04-catalog-and-print-files.md#43-the-art-adapter)). Until then, which of art's works may be printed is a per-work allow-list in the shop's `config/sources.json` (ADR-0035).
- No mock-mode deployment on the cluster: mock mode runs only in CI (ADR-0029).

**Secrets** are built by `scripts/create-secrets.sh` from named keys in the node's
`.env`, never the whole file, and never printed. Deploy credentials never reach the app
pod; the live Stripe key and live Printful token only at go-live.

| Secret | Keys (app variable ← `.env` key) |
|---|---|
| `shop-env` | `PRINTFUL_TOKEN` ← `PRINTFUL_TOKEN_TEST` (test) or `PRINTFUL_TOKEN` (live); `STRIPE_SECRET_KEY` ← `STRIPE_TEST_TOKEN` (test) or `STRIPE_LIVE_TOKEN` (live); `STRIPE_WEBHOOK_SECRET` ← `STRIPE_TEST_WEBHOOK_SECRET` or `STRIPE_LIVE_WEBHOOK_SECRET`; `PRINTFUL_WEBHOOK_SECRET` and `PRINTFUL_WEBHOOK_PUBLIC_KEY` of that store; `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `ALLOWED_EMAILS`, `COOKIE_SECRET`, `STATUS_TOKEN_SECRET`; SES credentials; `PREVIEW_KEY` |
| `shop-litestream` | the backup bucket's access key and secret |
| runner registration | the runner's GitHub token |
| repository Actions secret | the kube-setup deploy token (Klaus) |

`--live` is refused unless `SHOP_MODE=live`
is passed too. The script prints key names and the Stripe key's prefix only.

**NetworkPolicy**, namespace `shop`, default deny: ingress from Traefik on the app port;
egress DNS, **TCP 443 to public addresses only** (the cluster's pod and service ranges
and the LAN excluded; Printful, Stripe, S3 and SES addresses change, so no host
allow-list), and art. art is a Knative service: its in-cluster name resolves to Knative's
internal gateway, so the egress rule allows that gateway (namespace, labels and port in
kube-setup), not art's pods. **Ingress** also allows art's Knative service, if art calls
`/api/offers` in-cluster (Cluster, 2026-11-26, answering review C F20).

## 2. Configuration

### 2.1 Mode (ADR-0029)

`SHOP_MODE = mock | test | live` decides everything that must agree (review 1 F25):

| | mock (CI only) | test (before go-live) | live |
|---|---|---|---|
| Printful | the mock service | the **test store** (its own token) | the live store |
| Stripe | the mock service | Stripe test mode | Stripe live mode |
| Confirm at Printful | the mock's confirm | **none**: the adapter has no confirm method | yes |
| Database files | `catalog.db` + `mock.db` | `catalog.db` + `test.db` | `catalog.db` + `live.db` |
| Customer e-mail | allow-list | allow-list | everyone |
| Preview gate (`PREVIEW_GATE`) | on | on | **on until Klaus's own orders are received**, then off |
| Banner, `noindex` | yes | yes | no |
| `/api/offers` | empty | empty | empty while the gate is on |
| Keys allowed | mock keys only | `rk_test_` and the test store's token | `rk_live_` and the live store's token |

The preview gate exempts `/health*`, `/webhooks/*`, `/auth/*`, `/files/*`, `/img/*` and
`/mockups/*` (Printful and Stripe fetch those without a cookie; review B F2).

At startup the process checks: the key prefixes match the mode; mock keys only with mock
URLs and real keys only with real hosts; the Printful token's store is the mode's
expected store (`PRINTFUL_STORE_TEST` / `PRINTFUL_STORE_LIVE`) with the needed scopes. A
**wrong** answer or a configuration error stops the start; **no** answer from Printful
doesn't ([06 §3](06-fulfilment.md#3-printful-adapter)). Going live is `SHOP_MODE=live`
plus the live Secret, made by Cluster on Klaus's word; the gate goes off in a second
step ([12 §4](12-testing.md#4-go-live-checklist-klaus-decides-each-box)).

### 2.2 Variables

| Variable | Purpose |
|---|---|
| `SHOP_MODE` | above |
| `PUBLIC_URL`, `DATA_DIR` | the shop's address; database, files, images |
| `SOURCES_REFRESH` | `on` (default on the cluster) or `off` (default in mock mode): refresh content sources every 10 minutes |
| `SOURCES_CONFIG`, `SKUS_CONFIG` | paths to `config/sources.json` and `config/skus.json` (overridable in tests); placeholder prices are refused in live mode |
| `PRINTFUL_BASE_URL`, `STRIPE_API_BASE` | set only in mock mode, never to the real hosts; mock keys start with `mock_printful_` and `mock_stripe_` |
| `PREVIEW_GATE`, `PREVIEW_KEY` | the gate (§2.1) |
| `PRINTFUL_STORE_TEST`, `PRINTFUL_STORE_LIVE` | expected store per mode; **values in kube-setup** |
| `PRINTFUL_WEBHOOK_PUBLIC_KEY` | checked against `x-pf-webhook-public-key` |
| `STATUS_TOKEN_SECRET` | status links ([07 §1](07-orders-data-jobs.md#1-identifiers)) |
| secrets of §1 | |
| `SHIP_COUNTRIES` | `US` (ADR-0011) |
| `MARGIN_FLOOR_CENTS`, `SHIPPING_MARKUP_CENTS`, `PROVIDER_TAX_ALLOWANCE_PCT`, `STRIPE_FEE_PCT`, `STRIPE_FEE_FIXED_CENTS` | cost checks ([05 §2](05-quote-checkout-payment.md#2-quote), [06 §4](06-fulfilment.md#4-submission)); the fee estimate includes Stripe Tax's percentage |
| `PROVIDER_RETRY_WINDOW_HOURS`, hold deadlines per reason, `COMPLETE_AFTER_SHIPPED_DAYS` | ADR-0010, [07 §2.5](07-orders-data-jobs.md#25-holds), [07 §2.7](07-orders-data-jobs.md#27-completion) |
| `MAX_INPUT_MEGAPIXELS` | uploads and originals ([04 §5](04-catalog-and-print-files.md#5-print-files)) |
| fail-safe thresholds: `APPROVAL_OVER_CENTS`, `REPEAT_OVER_CENTS`, `REPEAT_ORDERS`, `BREAKER_ORDERS_24H`, `BREAKER_COST_CENTS_24H`, `MAX_ITEMS_PER_ORDER`, `MAX_ORDER_CENTS`, `SKU_MAX_QUANTITY` (JSON, `{"default": n, "<sku>": m}`) | **values in kube-setup's ConfigMap**, not in this repository; required in test and live mode; mock mode and tests use artificial values (`src/config.ts`) |
| `DELAY_NOTICE_HOURS`, `EMAIL_ENABLED`, `EMAIL_FROM`, `ALERT_EMAIL` | e-mail |

The process validates everything at startup and logs only which variables are present.

## 3. Backup and restore

- Litestream replicates **both** database files (`catalog.db` and the mode's) continuously to a new S3 bucket (Klaus creates it; never another service's), daily snapshot, 30 days.
- A nightly `VACUUM INTO` copy of both on the PVC. Velero backs up the PVC as for every service (the cluster's, not a shop addition).
- Restore test in CI (Litestream against MinIO in Docker) and once on the cluster before go-live, restoring both files.
- Files can be regenerated from the sources; the database can't. After a restore the reverse reconciliation **alerts** on paid sessions or provider orders without a local row ([07 §5](07-orders-data-jobs.md#5-reconciliation)); Klaus decides per alarm. It does not rebuild rows.

## 4. Observability

- Logs: JSON lines to stdout; the order id on order-related lines; no personal data, no secrets, no request bodies, **no query strings**. A test asserts the failure log printed in CI holds no personal data.
- `/health`: `{status, version}`, no dependency checks.
- **`/health/worker`** (review C F4): 200 while the job runner's last tick is under 5 minutes old, the last reconciliation finished within 2 hours and the last alert e-mail was accepted by SES; 503 otherwise. No provider is called. The uptime monitor checks it too, and its own notification is the **second alert channel** when the runner or SES fails.
- Alerts by e-mail ([09 §2](09-notifications.md#2-alerts-to-klaus)): order number and an admin link, never the customer's name, address or e-mail. Metrics deferred: if wanted later, the cluster's Grafana Alloy scrapes annotated pods and ships allow-listed metric names (Cluster, 2026-11-25).
- The admin's System page for a human view.

## 5. Runbooks (written during implementation, operational details in the private repository)

| Situation | Outline |
|---|---|
| Rotate a Printful token | new token → `.env` → Secret → restart → re-register that store's webhook → new webhook secret |
| Rotate Stripe keys | new restricted key → `.env` → Secret → restart |
| Stripe webhook endpoints | created by Klaus in the Dashboard per mode, latest API version (ADR-0030); the test-mode endpoint disabled at go-live |
| Go live | checklist in [12 §4](12-testing.md#4-go-live-checklist-klaus-decides-each-box) |
| Restore the database | scale to 0 → `litestream restore` of both files → start → reverse reconciliation alarms → Klaus decides |
| Printful or Stripe outage | nothing: quotes and Pay fail gracefully; paid orders wait and retry; a restart during a Printful outage still starts (provider unverified) |
| Disable the shop quickly | disable works in the admin (art hides links within 10 minutes), or scale to 0 |
