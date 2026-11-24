# 7. Orders, data and jobs

## 1. Identifiers

| Id | Form | Where |
|---|---|---|
| Order id | 26-char ULID-like, lowercase base32 (time-ordered, URL-safe, ≤ 32 chars) | Our primary key; Stripe `client_reference_id`/metadata; Printful `external_id` (+ `-N` on resubmission) |
| Order number | `S-2026-000123` | Shown to customers and Klaus; printed on Printful's packing slip |
| Status token | 128 random bits, base64url; stored as SHA-256 | `/order/<id>?t=<token>` |

## 2. State machine

```
                  ┌─► abandoned       (Stripe call failed / customer cancelled)   ┐
 checkout_open ───┼─► expired         (session expired)                           ├ terminal, no money
                  ├─► payment_failed  (async payment failed)                      ┘
                  │
                  └─► paid ─┬─────────────► submitted ─► in_production ─► partially_shipped ─► shipped ─► delivered
                            │                 │ ▲            │
                            │ fail-safe       ▼ │            ▼
                            │ (ADR-0020)    on_hold ◄────────┘          (returns, reshipments: annotations)
                            ▼                 │
                   awaiting_approval          │
                     │ approve → submit       │ failure / cost guard / hold timeout
                     │ refund, or 72 h        ▼
                     │                  needs_attention ── Klaus "confirm anyway" ──► submitted
                     │                        │ timer or Klaus
                     ▼                        ▼
                  refunded ◄──────────── canceled (Printful or admin)
 any paid state ──(full refund, e.g. from the Stripe Dashboard)──► refunded
```

| From | To | Trigger (cause) |
|---|---|---|
| — | `checkout_open` | `POST /checkout` (storefront) |
| `checkout_open` | `abandoned` | Stripe error at creation, or cancel_url visited (storefront) |
| `checkout_open` | `expired` | `checkout.session.expired` (stripe_webhook) or reconciliation |
| `checkout_open` | `payment_failed` | `checkout.session.async_payment_failed` |
| `checkout_open` | `paid` | `checkout.session.completed`/`async_payment_succeeded` with paid status, or success page re-fetch, or reconciliation |
| `paid` | `submitted` | submit job (job) |
| `paid` | `awaiting_approval` | fail-safe check: large or unusual order, or circuit breaker tripped (job) |
| `awaiting_approval` | `paid` → submit | Klaus approves, or resets the breaker (admin) |
| `awaiting_approval` | `refunded` | Klaus refunds (admin), or 72 h without approval (job) |
| `paid` | `needs_attention` | permanent failure, cost guard, retries exhausted (job) |
| `submitted` | `on_hold`, `in_production`, `partially_shipped`, `shipped`, `delivered`, `canceled` | Printful status (printful_webhook, reconciliation); skip-forward allowed |
| `on_hold` | `submitted`, `in_production`, `canceled` | Printful status |
| `in_production` | `partially_shipped`, `shipped`, `delivered`, `on_hold`, `canceled` | Printful status |
| `partially_shipped` | `shipped`, `delivered` | shipments |
| `shipped` | `delivered` | `shipment_delivered` |
| `needs_attention` | `submitted` | Klaus "confirm anyway" / retry (admin) |
| `needs_attention`, `canceled`, `on_hold` (after timeout) | `refunded` | refund job (job, admin) |
| any paid state | `refunded` | `charge.refunded` full (stripe_webhook) |

Terminal: `abandoned`, `expired`, `payment_failed`, `delivered`, `refunded`. (A
`delivered` order can still receive a partial refund or a dispute; those are
annotations, not state changes.)

**Transition rule** (from Pressline): one SQLite transaction does
`UPDATE orders SET state = :to, updated_at = :now WHERE id = :id AND state = :from`
and, only if one row changed, `INSERT INTO order_transitions(...)`. The loser of a
race changes nothing and re-reads. Allowed edges are a table in code; an illegal
edge throws. **Annotations** are transition rows with `from = to` (e.g. "partial
refund $12.00", "dispute opened").

## 3. Schema

SQLite (`node:sqlite`), WAL mode, `foreign_keys = ON`, migrations numbered in
`src/db/migrations/NNN_name.sql`, applied at startup inside a transaction.

```sql
CREATE TABLE pictures (            -- cache of art's manifest + Klaus's per-picture settings
  uid            TEXT PRIMARY KEY,
  slug           TEXT NOT NULL,
  title          TEXT NOT NULL,
  manifest_json  TEXT NOT NULL,    -- the work as art published it
  content_v      TEXT NOT NULL,    -- art's `v`
  enabled        INTEGER NOT NULL DEFAULT 0,
  master_path    TEXT,             -- uploaded print master, if any
  source_px_w    INTEGER, source_px_h INTEGER,
  seen_at        TEXT NOT NULL     -- last time it was in the manifest
);

CREATE TABLE offers (              -- (picture, SKU) that Klaus enabled
  uid            TEXT NOT NULL REFERENCES pictures(uid),
  sku_id         TEXT NOT NULL,    -- from config/skus.json
  enabled        INTEGER NOT NULL DEFAULT 1,
  price_cents    INTEGER,          -- NULL = SKU default
  crop_json      TEXT,             -- {x,y,w,h} as fractions; NULL = default
  print_file_sha TEXT REFERENCES print_files(sha256),
  mockup_sha     TEXT,
  effective_dpi  INTEGER,
  PRIMARY KEY (uid, sku_id)
);

CREATE TABLE print_files (
  sha256         TEXT PRIMARY KEY,
  render_key     TEXT NOT NULL UNIQUE,   -- uid|v|sku|crop|renderer
  path           TEXT NOT NULL,
  width_px INTEGER NOT NULL, height_px INTEGER NOT NULL, bytes INTEGER NOT NULL,
  created_at     TEXT NOT NULL
);

CREATE TABLE carts (
  id             TEXT PRIMARY KEY,       -- cookie value (random)
  uid            TEXT,                   -- one picture per cart
  items_json     TEXT NOT NULL,          -- [{sku_id, quantity}]
  address_json   TEXT,
  quote_id       TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE quotes (
  id             TEXT PRIMARY KEY,
  cart_id        TEXT NOT NULL,
  items_json     TEXT NOT NULL,          -- snapshot incl. unit prices
  address_json   TEXT NOT NULL,
  options_json   TEXT NOT NULL,          -- shipping options as quoted
  expires_at     TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

CREATE TABLE orders (
  id                 TEXT PRIMARY KEY,
  number             TEXT NOT NULL UNIQUE,
  state              TEXT NOT NULL,
  status_token_hash  TEXT NOT NULL,
  uid                TEXT NOT NULL,      -- the picture
  email              TEXT,               -- PII, purged later
  ship_name          TEXT, ship_line1 TEXT, ship_line2 TEXT, ship_city TEXT,
  ship_state         TEXT, ship_zip TEXT, ship_country TEXT NOT NULL, ship_phone TEXT,
  shipping_method    TEXT NOT NULL,
  shipping_cents     INTEGER NOT NULL,
  items_cents        INTEGER NOT NULL,
  tax_cents          INTEGER,            -- from Stripe after payment
  paid_cents         INTEGER,            -- amount_total from Stripe
  refunded_cents     INTEGER NOT NULL DEFAULT 0,
  currency           TEXT NOT NULL DEFAULT 'usd',
  stripe_customer_id TEXT, stripe_session_id TEXT UNIQUE, stripe_payment_intent TEXT,
  card_fingerprint   TEXT, radar_risk_level TEXT,    -- fail-safe inputs (ADR-0020)
  hold_reasons       TEXT,                           -- why awaiting_approval, if it was
  mode               TEXT NOT NULL,      -- test | live
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, paid_at TEXT, purged_at TEXT
);
CREATE INDEX orders_state ON orders(state, updated_at);

CREATE TABLE order_items (
  id              TEXT PRIMARY KEY,
  order_id        TEXT NOT NULL REFERENCES orders(id),
  uid             TEXT NOT NULL,
  sku_id          TEXT NOT NULL,
  name            TEXT NOT NULL,         -- frozen copy for display
  provider        TEXT NOT NULL,
  provider_variant_id INTEGER NOT NULL,
  unit_cents      INTEGER NOT NULL,
  quantity        INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 10),
  print_file_sha  TEXT NOT NULL REFERENCES print_files(sha256)
);

CREATE TABLE order_transitions (     -- append-only history
  id         INTEGER PRIMARY KEY,
  order_id   TEXT NOT NULL REFERENCES orders(id),
  from_state TEXT, to_state TEXT NOT NULL,
  cause      TEXT NOT NULL,          -- storefront|stripe_webhook|printful_webhook|job|reconciliation|admin
  cause_ref  TEXT,                   -- event id, job id, admin email
  note       TEXT,
  at         TEXT NOT NULL
);

CREATE TABLE provider_orders (
  order_id          TEXT NOT NULL REFERENCES orders(id),
  provider          TEXT NOT NULL,
  external_id       TEXT NOT NULL UNIQUE,
  provider_order_id TEXT,
  attempt           INTEGER NOT NULL DEFAULT 1,
  state             TEXT NOT NULL,   -- submitting|draft|confirmed|canceled|failed
  status            TEXT,            -- provider's normalised status
  costs_json        TEXT,            -- provider costs as reported
  last_error        TEXT,
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (order_id, provider)
);

CREATE TABLE shipments (
  id                TEXT PRIMARY KEY,  -- provider shipment id
  order_id          TEXT NOT NULL REFERENCES orders(id),
  carrier TEXT, service TEXT, tracking_number TEXT, tracking_url TEXT,
  shipped_at TEXT, delivered_at TEXT, estimated_delivery TEXT,
  is_reshipment     INTEGER NOT NULL DEFAULT 0,
  items_json        TEXT NOT NULL,
  status            TEXT
);

CREATE TABLE inbound_events (
  provider     TEXT NOT NULL,
  event_id     TEXT NOT NULL,
  type         TEXT NOT NULL,
  payload_json TEXT,                 -- redacted by the purge job
  received_at  TEXT NOT NULL,
  processed_at TEXT,
  outcome      TEXT,
  PRIMARY KEY (provider, event_id)
);

CREATE TABLE jobs (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL,         -- order.submit, stripe.event, printful.event, printfile.render, mockup.create, email.send, reconcile, refund, purge
  key         TEXT NOT NULL,         -- dedupe key, e.g. order id
  payload_json TEXT,
  state       TEXT NOT NULL,         -- queued|running|done|failed
  attempts    INTEGER NOT NULL DEFAULT 0,
  run_after   TEXT NOT NULL,
  lease_until TEXT,
  last_error  TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX jobs_open ON jobs(kind, key) WHERE state IN ('queued','running');

CREATE TABLE emails (
  order_id TEXT NOT NULL, kind TEXT NOT NULL,   -- confirmation|shipped|refunded|delayed
  sent_at TEXT, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
  PRIMARY KEY (order_id, kind)
);

CREATE TABLE reconciliation_runs (
  id INTEGER PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT,
  report_json TEXT, alarms INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE settings (             -- runtime switches, e.g. the circuit breaker
  key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT
);

CREATE TABLE admin_audit (
  id INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL,
  action TEXT NOT NULL, target TEXT, details_json TEXT
);
```

## 4. Jobs

- One in-process runner: every 2 s it leases the oldest due job (`state=queued AND run_after<=now`, sets `running`, `lease_until=now+5min`), runs it, then marks `done`, or `queued` with `run_after` = backoff and `attempts+1`, or `failed` after its kind's limit.
- A job whose lease expired (crash, restart) is picked up again; every job is idempotent by design.
- At most one job per (kind, key) is open (partial unique index), so e.g. two webhooks for the same order don't create two submit jobs.
- Concurrency: 1 for Printful-calling jobs (respects the rate limit trivially at this volume), 2 for others.
- Scheduled kinds are seeded at startup: `reconcile` hourly, `catalog.refresh` daily, `manifest.refresh` every 10 min, `purge` daily, `backup.check` hourly.

## 5. Reconciliation

Hourly job (and on demand from the admin); dry-run option for tests. Steps:

1. `checkout_open` older than session expiry + 30 min: re-fetch the session; paid → `paid` (+ submit); expired → `expired`.
2. `paid` for more than 15 min without a running submit job: enqueue submit; alarm if older than 24 h.
3. Every non-terminal order past `paid`: re-fetch the Printful order and its shipments; apply status and tracking.
4. Stripe: refunds and disputes in the last 90 days for orders not marked `refunded` (`charge.refunded` missed).
5. `inbound_events` not processed after 10 min: re-run.
6. `emails` unsent with attempts < 5: retry.
7. Report: counts per state, alarms. Stored in `reconciliation_runs`; an email to Klaus **only when there are alarms**.

Alarm conditions: an order in `awaiting_approval` (once, then a reminder 24 h before its automatic refund); circuit breaker tripped; paid but not submitted for 24 h; `needs_attention` older than 12 h;
`on_hold` older than 24 h; any webhook signature failures in the last hour; last
Litestream replication older than 2 h; a SKU disabled by availability.

## 6. Retention and purge

| Data | Kept |
|---|---|
| Orders, items, transitions, amounts | 10 years (accounting/tax records) |
| Name, email, address, phone on orders | Until 90 days after the order is terminal, then replaced by `NULL` (country and state kept); `purged_at` set |
| `inbound_events.payload_json` | 30 days, then set to `NULL` (Stripe payloads contain addresses) |
| Carts | 30 days after last update |
| Quotes | 7 days |
| Abandoned/expired orders | Purged of PII after 7 days |
| Print files | While referenced by an offer or an order item of the last 12 months |
| Jobs done | 30 days |

Stripe and Printful keep their own copies under their own retention (stated in the privacy policy).
