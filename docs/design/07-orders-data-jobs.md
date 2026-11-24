# 7. Orders, data and jobs

Revised for review round 2 (2026-11-25): payment and fulfilment are separate
dimensions, exceptions are **holds** with deadlines, a cart holds any pictures, every
work is keyed by its source, print files are registered at the provider, and e-mails
are per parcel. ADR-0034 (state model), ADR-0026 (cart), ADR-0035 (sources),
ADR-0032 (order numbers).

## 1. Identifiers

| Id | Form | Where |
|---|---|---|
| Order id | 26 characters, lowercase base32, time-ordered, random tail | Primary key; Stripe `client_reference_id` and metadata; base of Printful's `external_id` |
| Order number | **5 random digits**, `10000`–`99999`, unique (ADR-0032) | Shown to customers and Klaus ("Order 48213"); printed on the packing slip; in e-mails. Allocated in the order's insert transaction: draw, insert, retry on a unique-constraint conflict (≤ 10 tries, then alert). Reveals nothing about volume. At ~500 orders a year the space lasts many years; widening to 6 digits later is a config change. |
| Printful `external_id` | `<order id>-<attempt>` (≤ 32 characters) | One per submission attempt (§2.3) |
| Status token | 128 random bits, base64url; only its SHA-256 is stored | Exchanged for a cookie on first use ([03 §7](03-customer-journey.md#7-order-status-page)) |
| Work | `(source_id, work_id)`, e.g. `(art, leyb1brb)` | Every table that refers to a picture (ADR-0035) |

## 2. State model

An order has **three independent parts**, each with its own small state machine, plus
**holds**. The customer-facing status is derived from them (§2.5). This replaces the
single `state` column of round 1 (review 1 F5).

### 2.1 Checkout and payment: `payment_state`

| State | Meaning |
|---|---|
| `checkout_open` | Stripe Checkout Session created, not paid, not known to be closed |
| `closed_unpaid` | Session confirmed **expired at Stripe** (expire call succeeded, `checkout.session.expired`, or a re-fetch says `expired`), or async payment failed. No money. |
| `paid` | Stripe reports the session paid |
| `partially_refunded` | Some money returned |
| `refunded` | All money returned (a succeeded refund) |

Edges:

| From | To | Cause |
|---|---|---|
| — | `checkout_open` | `POST /checkout` |
| `checkout_open` | `closed_unpaid` | only after Stripe confirms the session is expired or the async payment failed |
| `checkout_open`, **`closed_unpaid`** | `paid` | a verified paid session (webhook, success-page re-fetch, reconciliation). **A paid session always wins** (I1): a payment that arrives after the shop closed the checkout is a normal payment. |
| `paid`, `partially_refunded` | `partially_refunded`, `refunded` | `charge.refunded` / refund job, from the charge's `amount_refunded` |

`dispute_state` (`none`, `warning`, `open`, `won`, `lost`) is a separate field set from
`radar.early_fraud_warning.created` and `charge.dispute.*` (review 1 F6).

### 2.2 Fulfilment: `fulfilment_state`

| State | Meaning |
|---|---|
| `none` | Nothing sent to a provider |
| `submitting` | A submission attempt is claimed (row in `provider_orders`) |
| `draft` | Provider draft exists, costs calculating or done |
| `confirming` | `confirm_requested_at` written, confirm call in flight or answer unknown |
| `submitted` | Provider confirmed (`pending`, `inreview`) |
| `on_hold` | Provider hold (any reason; reasons are not parsed, review 1 F10) |
| `in_production` | Provider `inprocess` |
| `partially_shipped` | At least one shipment sent, not all |
| `shipped` | All shipments sent |
| `delivered` | All shipments delivered |
| `canceled` | Provider order cancelled (by us or by the provider) or draft deleted |
| `failed` | Provider reports `failed` |

Forward skips are allowed when a poll finds a later provider state. Fulfilment is
followed until the provider reports `delivered`, `canceled` or `failed`, **whatever the
payment state** (I6).

### 2.3 Submission attempts

`provider_orders` has one row **per attempt** (review 1 F16): `(order_id, provider,
attempt)`, `external_id = <order id>-<attempt>`. Attempt N+1 is allocated only after a
successful read shows attempt N `canceled` or gone (I5).

### 2.4 Holds

A **hold** stops the order from moving on until it is resolved. It replaces the states
`awaiting_approval` and `needs_attention` of round 1 (review 1 F5, F8).

| Field | Meaning |
|---|---|
| `kind` | `approval` (fail-safe, [06 §8](06-fulfilment.md#8-fail-safes-against-large-or-unusual-orders)), `attention` (a failure the system can't resolve), `provider` (Printful hold), `fraud` (early fraud warning or dispute) |
| `reasons` | **All** conditions that applied, evaluated together (e.g. `["amount", "breaker"]`) |
| `since`, `deadline_at` | Deadline from configuration per kind |
| `deadline_action` | `refund` (only if I4 allows), or `alert` |
| `resolved_at`, `resolved_by`, `resolution` | `approved`, `refunded`, `released` (breaker reset, only for holds whose sole reason is `breaker`), `expired`, `cleared` (provider removed its hold) |

Reconciliation enforces deadlines; the admin shows each open hold with its time left.

### 2.5 Customer-facing status (derived)

| Condition (first match) | Customer sees |
|---|---|
| `payment_state = refunded` | Refunded |
| `payment_state = checkout_open` | Waiting for payment |
| `payment_state = closed_unpaid` | Not paid |
| open hold of any kind, or `fulfilment_state ∈ {none, submitting, draft, confirming}` | Payment received — we're checking your order (wording for holds is honest, review 1 F17) |
| `submitted`, `on_hold` (provider) | In preparation |
| `in_production` | In production |
| `partially_shipped` | Partly shipped (per parcel: carrier, tracking) |
| `shipped` | Shipped (per parcel) |
| `delivered` | Delivered |
| `canceled`/`failed` without full refund | Delayed — we're on it |

### 2.6 Invariants

Checked by the invariant tests ([12 §1](12-testing.md#1-layers)) and asserted in code
where cheap.

| Id | Invariant |
|---|---|
| I1 | A paid Checkout Session always ends with `payment_state ∈ {paid, partially_refunded, refunded}`, never `closed_unpaid`. |
| I2 | Fulfilment starts only if `payment_state = paid`, no open hold, no refund requested, `dispute_state = none`. |
| I3 | Confirm is requested at most once per attempt: `confirm_requested_at` is written **before** the call, in a transaction that also checks no refund is requested or open. |
| I4 | An **automatic** refund of a submitted order requires a fresh, successful read of the provider order showing it can't be charged (not found, `draft`, `canceled`, or `failed` and not charged). Otherwise the hold's action becomes `alert`. |
| I5 | Attempt N+1 exists only after attempt N is proven `canceled` or gone. |
| I6 | Fulfilment is followed (webhooks + reconciliation) until a provider end state, independent of payment. |
| I7 | A refund (any source, Stripe Dashboard included) triggers: cancel fulfilment if still cancellable; otherwise an `attention` hold with `alert`. |
| I8 | The amount charged equals the quote's items + shipping (+ Stripe's tax). |
| I9 | At most one `checkout_open` order per cart (review 1 F2). |

### 2.7 Transitions in code

Each part changes with a conditional update (`… WHERE id = ? AND <part> = ?`) plus a
row in `order_events` in the same transaction; the loser of a race changes nothing and
re-reads. Facts without a state change (a partial refund, a dispute opened) are events
too.

## 3. Schema

SQLite via `node:sqlite`, WAL, `foreign_keys = ON`, numbered migrations. **One database
file per mode** (`mock.db`, `test.db`, `live.db`; ADR-0029), so test orders can never
meet live reconciliation.

```sql
-- Works from content sources (ADR-0035). Only the shop's own allow-listed fields.
CREATE TABLE works (
  source_id        TEXT NOT NULL,          -- 'art'; later e.g. 'christina-art', 'instagetter'
  work_id          TEXT NOT NULL,          -- the source's stable id (art: uid)
  title            TEXT NOT NULL,
  creator          TEXT,
  year             TEXT,
  kind             TEXT,                   -- 'painting' | 'photograph' | …, drives wording
  canonical_url    TEXT NOT NULL,          -- the work's page at the source
  original_url     TEXT NOT NULL,
  original_sha256  TEXT,                   -- set when fetched; re-render only when it changes
  original_px_w    INTEGER, original_px_h INTEGER,
  source_version   TEXT,                   -- e.g. art's `v`; triggers a re-check, not a re-render
  prints_allowed   INTEGER NOT NULL,       -- consent from the source (feed flag or source default)
  enabled          INTEGER NOT NULL DEFAULT 0,  -- Klaus's switch in the admin
  seen_at          TEXT NOT NULL,
  PRIMARY KEY (source_id, work_id)
);

CREATE TABLE display_images (             -- rendered by the shop (ADR-0035), no metadata
  sha256 TEXT PRIMARY KEY, source_id TEXT NOT NULL, work_id TEXT NOT NULL,
  width_px INTEGER NOT NULL, format TEXT NOT NULL, path TEXT NOT NULL
);

CREATE TABLE offers (                     -- (work, SKU) Klaus enabled
  source_id TEXT NOT NULL, work_id TEXT NOT NULL, sku_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  price_cents INTEGER,                    -- NULL = SKU default
  crop_json TEXT,                         -- anchor (one of 9) or a box; NULL = centred
  orientation TEXT,                       -- 'portrait' | 'landscape', from the work
  print_file_sha TEXT REFERENCES print_files(sha256),
  mockup_sha TEXT,
  effective_dpi INTEGER,
  PRIMARY KEY (source_id, work_id, sku_id),
  FOREIGN KEY (source_id, work_id) REFERENCES works(source_id, work_id)
);

CREATE TABLE print_files (
  sha256 TEXT PRIMARY KEY,
  render_key TEXT NOT NULL UNIQUE,        -- source|work|original_sha256|sku|crop|renderer
  path TEXT NOT NULL, width_px INTEGER NOT NULL, height_px INTEGER NOT NULL, bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE provider_files (             -- registration at the provider (review 2 F2)
  print_file_sha TEXT NOT NULL REFERENCES print_files(sha256),
  provider TEXT NOT NULL,
  provider_file_id TEXT,
  status TEXT NOT NULL,                   -- pending | waiting | ok | failed
  last_error TEXT, checked_at TEXT NOT NULL,
  PRIMARY KEY (print_file_sha, provider)
);

CREATE TABLE carts (                      -- ADR-0026: any pictures
  id TEXT PRIMARY KEY,                    -- random cookie value
  address_json TEXT,
  quote_id TEXT,
  open_order_id TEXT,                     -- I9
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE cart_items (
  cart_id TEXT NOT NULL REFERENCES carts(id),
  source_id TEXT NOT NULL, work_id TEXT NOT NULL, sku_id TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity >= 1),   -- upper limits are configuration (F11 / review 2 F1)
  PRIMARY KEY (cart_id, source_id, work_id, sku_id)
);

CREATE TABLE quotes (
  id TEXT PRIMARY KEY, cart_id TEXT NOT NULL,
  items_json TEXT NOT NULL,               -- snapshot incl. unit prices
  address_json TEXT NOT NULL,
  options_json TEXT NOT NULL,             -- shipping options as quoted
  est_cost_cents INTEGER,                 -- pre-payment cost check ([05 §2](05-quote-checkout-payment.md#2-quote))
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,            -- 5 random digits (ADR-0032)
  payment_state TEXT NOT NULL,
  fulfilment_state TEXT NOT NULL DEFAULT 'none',
  dispute_state TEXT NOT NULL DEFAULT 'none',
  status_token_hash TEXT NOT NULL,
  cart_id TEXT,
  email TEXT,                              -- PII, purged later
  ship_name TEXT, ship_line1 TEXT, ship_line2 TEXT, ship_city TEXT,
  ship_state TEXT, ship_zip TEXT, ship_country TEXT NOT NULL,
  shipping_method TEXT NOT NULL,
  shipping_cents INTEGER NOT NULL, items_cents INTEGER NOT NULL,
  tax_cents INTEGER, paid_cents INTEGER, refunded_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'usd',
  stripe_customer_id TEXT, stripe_session_id TEXT UNIQUE, stripe_payment_intent TEXT,
  card_fingerprint TEXT, radar_risk_level TEXT,     -- fail-safe inputs (absent for some methods: not a hold reason)
  refund_requested_at TEXT,                         -- I3, I7
  email_bounced_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, paid_at TEXT, purged_at TEXT
);

CREATE TABLE order_items (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id),
  source_id TEXT NOT NULL, work_id TEXT NOT NULL, sku_id TEXT NOT NULL,
  name TEXT NOT NULL,                     -- frozen copy for display
  provider TEXT NOT NULL, provider_variant_id INTEGER NOT NULL,
  unit_cents INTEGER NOT NULL, tax_cents INTEGER,
  quantity INTEGER NOT NULL CHECK (quantity >= 1),
  print_file_sha TEXT NOT NULL REFERENCES print_files(sha256)
);

CREATE TABLE order_events (               -- append-only history of every change and fact
  id INTEGER PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id),
  part TEXT NOT NULL,                     -- payment | fulfilment | dispute | hold | email | note
  from_value TEXT, to_value TEXT,
  cause TEXT NOT NULL,                    -- storefront | stripe_webhook | printful_webhook | job | reconciliation | admin
  cause_ref TEXT, note TEXT, at TEXT NOT NULL
);

CREATE TABLE holds (
  id INTEGER PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id),
  kind TEXT NOT NULL, reasons_json TEXT NOT NULL,
  since TEXT NOT NULL, deadline_at TEXT NOT NULL, deadline_action TEXT NOT NULL,
  resolved_at TEXT, resolved_by TEXT, resolution TEXT
);
CREATE INDEX holds_open ON holds(order_id) WHERE resolved_at IS NULL;

CREATE TABLE provider_orders (            -- one row per submission attempt
  order_id TEXT NOT NULL REFERENCES orders(id), provider TEXT NOT NULL, attempt INTEGER NOT NULL,
  external_id TEXT NOT NULL UNIQUE, provider_order_id TEXT,
  state TEXT NOT NULL,                    -- submitting | draft | confirming | confirmed | canceled | gone | failed
  confirm_requested_at TEXT,              -- I3
  status TEXT, costs_json TEXT, last_error TEXT, updated_at TEXT NOT NULL,
  PRIMARY KEY (order_id, provider, attempt)
);

CREATE TABLE shipments (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id),
  carrier TEXT, service TEXT, tracking_number TEXT, tracking_url TEXT,
  shipped_at TEXT, delivered_at TEXT, estimated_delivery TEXT,
  is_reshipment INTEGER NOT NULL DEFAULT 0, items_json TEXT NOT NULL, status TEXT
);

CREATE TABLE inbound_events (
  provider TEXT NOT NULL, event_id TEXT NOT NULL, type TEXT NOT NULL,
  payload_json TEXT,                      -- redacted by the purge job after 30 days
  received_at TEXT NOT NULL, processed_at TEXT, outcome TEXT,
  PRIMARY KEY (provider, event_id)
);

CREATE TABLE jobs (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, key TEXT NOT NULL, payload_json TEXT,
  state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  run_after TEXT NOT NULL, lease_until TEXT, last_error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX jobs_open ON jobs(kind, key) WHERE state IN ('queued','running');

CREATE TABLE emails (                     -- ADR-0027: one per (order, kind, reference)
  order_id TEXT NOT NULL, kind TEXT NOT NULL,   -- confirmation | shipped | delayed | refunded | canceled | link
  ref TEXT NOT NULL DEFAULT '',                 -- shipment id for 'shipped'; '' otherwise
  sent_at TEXT, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
  PRIMARY KEY (order_id, kind, ref)
);

CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT);
CREATE TABLE reconciliation_runs (id INTEGER PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT, report_json TEXT, alarms INTEGER NOT NULL DEFAULT 0);
CREATE TABLE admin_audit (id INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT, details_json TEXT);
```

## 4. Jobs

- One in-process runner leases the oldest due job (`run_after <= now`, lease 5 min), runs it, then marks it done, re-queues it with backoff, or fails it after its kind's limit. Expired leases are picked up again; every job is idempotent.
- At most one open job per (kind, key).
- Printful-calling jobs run one at a time; they pause when `X-Ratelimit-Remaining` is low.
- All times come from a `Clock` interface (no direct `Date.now()`; a lint rule), so tests and the mock environment control time (review 1 F23).
- Kinds: `order.submit`, `order.cancel`, `refund`, `stripe.event`, `printful.event`, `printfile.render`, `printfile.register`, `display.render`, `mockup.create`, `email.send`, `reconcile`, `catalog.refresh`, `sources.refresh`, `purge`, `backup.check`.

## 5. Reconciliation

Hourly, and on demand (dry-run available). **Forward** (from local rows):
1. `checkout_open` past expiry + 30 min: re-fetch; paid → `paid`; expired → `closed_unpaid`.
2. `paid` with fulfilment `none` and no open hold for > 15 min: enqueue submit.
3. Every order whose fulfilment isn't at a provider end state: re-fetch the provider order and shipments; apply (I6).
4. `confirming` attempts: re-read; resolve to `confirmed` or back to `draft`.
5. Refunds and disputes of the last 90 days that the shop hasn't recorded.
6. Holds past their deadline: apply `deadline_action` (I4 for refunds).
7. Unprocessed inbound events older than 10 min: re-run.
8. Unsent e-mails with attempts < 5: retry.

**Reverse** (review 1 F15): list the provider's recent orders (last 100, `limit`/`offset`)
and Stripe's paid Checkout Sessions of the last 7 days; any one without a matching local
row, or with a mismatching state, is an **alarm**. The sweep alerts; it does not rebuild
rows (after a restore, Klaus decides per alarm).

Report stored in `reconciliation_runs`; an e-mail to Klaus only when there are alarms.

## 6. Retention and purge

| Data | Kept |
|---|---|
| Orders, items, events, amounts | 10 years (accounting and tax records) |
| Name, e-mail, address on orders | Until **180 days** after the order's last end state (covers chargebacks), then `NULL` (country and state kept); `purged_at` set |
| Stripe Customer objects | Deleted by the purge job at the same time (they hold name and address) |
| `inbound_events.payload_json` | 30 days |
| Carts, quotes | 30 days, 7 days |
| Orders never paid | personal data purged after 7 days |
| Print files, display images | while referenced by an offer or by an order item of the last 12 months |
| Jobs done | 30 days |
