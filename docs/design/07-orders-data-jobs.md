# 7. Orders, data and jobs

Revised for review round 2 (2026-11-25): payment and fulfilment are separate
dimensions, exceptions are **holds** with deadlines, a cart holds any pictures, every
work is keyed by its source, print files are registered at the provider, and e-mails
are per parcel. Round 2 fold-in (2026-11-26): attempt-aware invariants I1–I11, refunds,
completion, a shared catalog file. ADR-0034 (state model), ADR-0026 (cart), ADR-0035 (sources),
ADR-0032 (order numbers).

## 1. Identifiers

| Id | Form | Where |
|---|---|---|
| Order id | 26 characters, lowercase base32, time-ordered, random tail | Primary key; Stripe `client_reference_id` and metadata; base of Printful's `external_id` |
| Order number | **5 random digits**, `10000`–`99999`, unique (ADR-0032) | Shown to customers and Klaus ("Order 48213"); printed on the packing slip; in e-mails. Allocated in the order's insert transaction: draw, insert, retry on a unique-constraint conflict (≤ 10 tries, then alert). Reveals nothing about volume. Never-paid orders are deleted after 7 days, which frees their numbers (review C F13). Widening to 6 digits later is a config change. |
| Printful `external_id` | `<order id>-<attempt>` (≤ 32 characters) | One per submission attempt (§2.3) |
| Status token | `HMAC-SHA256(STATUS_TOKEN_SECRET, order id)`, base64url, first 128 bits; **not stored**, recomputed for every e-mail; rotating the secret revokes every link (review B F6) | Exchanged for a cookie on first use ([03 §7](03-customer-journey.md#7-order-status-page)) |
| Work | `(source_id, work_id)`, e.g. `(art, leyb1brb)` | Every table that refers to a picture (ADR-0035) |

## 2. State model

An order has **three independent parts**, each with its own small state machine, plus
**holds** and **refunds**. The customer-facing status is derived from them (§2.6). This
replaces the single `state` column of round 1 (review 1 F5). Round 2 (reviews A–D,
`docs/reviews/2026-11-26-triage-round-2.md`) made the invariants attempt-aware, made a
successful delete the proof before a refund, and added completion.

### 2.1 Checkout and payment: `payment_state`

| State | Meaning |
|---|---|
| `checkout_open` | Stripe Checkout Session created, not paid, not known to be closed |
| `closed_unpaid` | Session confirmed **expired at Stripe** (expire call succeeded, `checkout.session.expired`, or a re-fetch says `expired`), async payment failed, or no session was ever created (§2.1.1). No money. |
| `paid` | Stripe reports the session paid |
| `partially_refunded` | Some money returned |
| `refunded` | All money returned (`refunded_cents ≥ paid_cents`) |

| From | To | Cause |
|---|---|---|
| — | `checkout_open` | `POST /checkout` |
| `checkout_open` | `closed_unpaid` | only after Stripe confirms the session is expired, the async payment failed, or the session id can't be recovered (§2.1.1) |
| `checkout_open`, **`closed_unpaid`** | `paid` | a verified paid session (webhook, success-page re-fetch, an expire refused as "complete", reconciliation). **A paid session always wins** (I1). |
| `paid`, `partially_refunded` | `partially_refunded`, `refunded` | `charge.refunded` or the refund job, from the charge's `amount_refunded` |

**The payment transaction** (review C F1). The Stripe reads come first (session, payment
intent, charge, line items). Then **one** SQLite transaction: `payment_state → paid`, the
amounts and fail-safe inputs, the evaluation of **every** hold condition and the breaker
([06 §8](06-fulfilment.md#8-fail-safes-against-large-or-unusual-orders)), the hold row
or the `order.submit` job, `failsafe_checked_at`, the cart emptied and detached
(`carts.open_order_id = NULL`, items deleted), and the confirmation e-mail job. SQLite
serialises writers, so the breaker count is exact. A paid order without
`failsafe_checked_at` is repaired by re-running this transaction, never by enqueuing a
submit (I11).

#### 2.1.1 A lost session id

If the process dies after Stripe created the session and before the shop stored its id,
the order is `checkout_open` without `stripe_session_id`. The customer's next **Pay** repeats
the create for that order with the same idempotency keys and identical parameters (the
session expiry is stored with the order), which returns the same session (code review
2026-11-25, F1); past the session's expiry it closes the order and starts a new one.
Reconciliation closes such an order after 24 h (`closed_unpaid`, with a note). The reverse sweep
(§5) still catches a payment on such a session.

### 2.2 Disputes: `dispute_state`

| From | To | Cause |
|---|---|---|
| `none` | `warning` | `radar.early_fraud_warning.created` (opens a `fraud` hold) |
| `warning` | `none` | Klaus resolves the fraud hold as `approved` (a false alarm) |
| `none`, `warning` | `open` | `charge.dispute.created`: open `fraud` holds switch to action `alert` |
| `open` | `won`, `lost` | `charge.dispute.closed`: the fraud hold is resolved (`won`: Klaus decides on fulfilment; `lost`: closed) |

Never an automatic refund while `dispute_state ∈ {open, lost}`: Stripe refuses it
(`charge_disputed`), and the job treats that error as final.

### 2.3 Fulfilment: `fulfilment_state`

`fulfilment_state` mirrors the **newest attempt** (§2.4). Events for older attempts are
recorded but don't move it.

| State | Meaning |
|---|---|
| `none` | Nothing sent to a provider |
| `submitting` | An attempt is claimed (row in `provider_orders`) |
| `draft` | Provider draft exists, costs calculating or done |
| `confirming` | `confirm_requested_at` written, answer unknown |
| `submitted` | Provider confirmed (`pending`, `inreview`) |
| `on_hold` | Provider hold (reasons are not parsed, review 1 F10) |
| `in_production` | Provider `inprocess` |
| `partially_shipped` | At least one shipment sent, not all |
| `shipped` | All shipments sent |
| `delivered` | All shipments delivered |
| `canceled` | The newest attempt is cancelled (by the shop or the provider) or its draft deleted |
| `failed` | Provider reports `failed` |
| `test_draft_ok` | **Test mode only**: the draft passed the cost guard and stays in the test store for inspection (§2.9) |

| From | To | Cause |
|---|---|---|
| `none`, `canceled` | `submitting` | the submit job claims attempt N (N > 1 only by §2.4) |
| `submitting` | `draft` | draft created, or found by `external_id` |
| `draft` | `confirming` | the confirm transaction (I3) |
| `confirming` | `submitted` | confirm answered, or a read shows it confirmed |
| `confirming` | `draft` | after the quiet period a read shows `draft`: the **same** order may be confirmed again (I3) |
| `draft`, `confirming` | `canceled` | the shop deleted the draft |
| `submitted` | `on_hold` | `order_put_hold` |
| `on_hold` | `submitted` | `order_remove_hold` |
| `submitted`, `on_hold` | `in_production` | provider `inprocess` |
| `in_production`, `partially_shipped` | `partially_shipped`, `shipped` | `shipment_sent` |
| `shipped` | `delivered` | every shipment delivered |
| any confirmed state | `canceled` | provider cancel, or the shop's cancel (I7) |
| any | `failed` | provider `failed` |
| `draft` | `test_draft_ok` | test mode, cost guard passed |

Forward skips are allowed when a poll finds a later provider state. `submitted → draft`
never happens.

### 2.4 Submission attempts

`provider_orders` has one row **per attempt** (review 1 F16): `(order_id, provider,
attempt)`, `external_id = <order id>-<attempt>`.
- Webhooks and polls are resolved to an attempt by `external_id`; an unknown
  `external_id` goes to the reverse sweep (§5).
- A cancel or delete the shop issued itself is recorded on the attempt and never opens a
  refund hold.
- **Attempt N+1** is started only by the admin's "retry submission" (after a cost-guard
  hold, a provider cancel or a failure Klaus has fixed) and only after attempt N is proven
  cancelled or deleted (I5). At most **3** attempts per order; then an `attention` hold.
- A **reshipment** Klaus makes in Printful's dashboard is linked from the reverse
  sweep's alarm ("link to order N"); it is stored as an attempt row with `kind = 'reship'`,
  never confirmed by the shop and not counted by the at-most-one-confirmed rule.

### 2.5 Holds

A **hold** stops the order from moving on until it is resolved (review 1 F5, F8).

| Field | Meaning |
|---|---|
| `kind` | `approval` (fail-safe), `attention` (a failure the system can't resolve), `provider` (Printful hold), `fraud` (early fraud warning or dispute) |
| `reasons` | **All** conditions that applied, evaluated together (e.g. `["amount", "breaker"]`) |
| `since`, `deadline_at` | Deadline from configuration per reason (the earliest applies) |
| `deadline_action` | `refund` (only if I4 allows) or `alert`; **`refund` only if every reason's action is `refund`**, recomputed when reasons change |
| `resolved_at`, `resolved_by`, `resolution` | `approved`, `refunded`, `released` (breaker reset, only for holds whose sole reason is `breaker`), `expired`, `cleared` (provider removed its hold) |

Actions per reason:

| Reason | Deadline action |
|---|---|
| `amount`, `quantity`, `repeat`, `breaker`, `risk` (approval) | `refund` |
| `cost_guard` | `refund` |
| `provider_unavailable` (retry window passed, or a create stays `Unknown`) | `refund` (I4) |
| `fulfilment_blocked` (submit found I2 false, I10) | `alert` |
| `provider_hold` (billing or any Printful hold) | `alert`, repeated daily; **never refunds by timer** (ADR-0010 note) |
| `early_fraud_warning` | before any confirm: **refund at once**; after: cancel if cancellable (I7), else `alert` |
| `dispute` | `alert` only |
| `refund_failed` | `alert`; admin actions "retry refund", "fulfil anyway"; a new deadline twice as long as the last |
| `amount_mismatch` | `alert` |
| `provider_refused` (Printful refused the draft: address, variant, file) | `refund` at once (the whole cart; 06 §7) |
| `costs_failed` | `refund` (I4) |
| `provider_failed` (`order_failed` after confirmation) | `alert`; the deadline tries a v2 delete (06 §7) |
| `confirm_failed` (three confirms without a confirmed order, or a refused confirm) | `alert` |
| `provider_canceled` (Printful cancelled the newest attempt) | `refund` at once if I4 holds (a cancel returns Printful's charge) |

Rules:
- Holds are resolved with a conditional update (`… WHERE id = ? AND resolved_at IS NULL`);
  only the winner acts (Klaus's Approve and a deadline can't both proceed).
- A **full refund resolves every open hold** of the order (`resolution = refunded`).
- "Confirm anyway" after a cost-guard hold is stored on the attempt (`override_by`,
  `override_at`); the submit job then skips the cost guard for that attempt only.
- The breaker counts orders paid since `max(now − 24 h, breaker_reset_at)`; the order
  that crosses the limit is itself held.

### 2.6 Customer-facing status (derived)

| Condition (first match) | Customer sees |
|---|---|
| `payment_state = checkout_open` | Waiting for payment |
| `payment_state = closed_unpaid` | Not paid |
| `refunded`, nothing shipped | Refunded |
| `refunded`, something shipped | Refunded — your item may still arrive |
| `fulfilment_state ∈ {none, submitting, draft, confirming}` (with or without a hold) | Payment received — we're checking your order |
| `submitted`, `on_hold` | In preparation |
| `in_production` | In production |
| `partially_shipped`, `shipped` | Shipped (per parcel: carrier, tracking; "returned to sender" or "delivery failed" when the provider says so) |
| `delivered` | Delivered |
| `canceled`, `failed` without full refund | Delayed — we're on it |
| `test_draft_ok` | Test order — nothing is produced |

A partially refunded order adds a line "Partly refunded: $x". Holds opened after the
first shipment don't change the status.

### 2.7 Completion

An order is **complete** (`completed_at` set) when one of these holds (review C F3):
1. every shipment is delivered;
2. everything is shipped and `COMPLETE_AFTER_SHIPPED_DAYS` have passed since the last shipment (delivery not confirmed, or `return_to_sender`/`failure` that Klaus has handled);
3. fully refunded and no attempt is live at the provider (I4's proof);
4. never paid (`closed_unpaid`);
5. `test_draft_ok`;
6. a dispute closed with nothing left to do.

Completion stops polling and starts the retention clock (§6). Late webhooks for a
complete order are still recorded.

### 2.8 Invariants

Checked by the invariant tests ([12 §1](12-testing.md#1-layers)) and asserted in code
where cheap.

| Id | Invariant |
|---|---|
| I1 | A paid Checkout Session always ends with `payment_state ∈ {paid, partially_refunded, refunded}`, never `closed_unpaid`. |
| I2 | A new attempt or a confirm happens only if `payment_state ∈ {paid, partially_refunded}`, `failsafe_checked_at` is set, no open hold, no shop-issued refund is requested or done, and `dispute_state ∈ {none, won}`. |
| I3 | Confirm is requested only inside a transaction that re-checks I2 and writes `confirm_requested_at`, right after a fresh read of the charge's `amount_refunded` at Stripe. The **same** provider order may be confirmed again after a read shows `draft` (at most 3 tries); one Printful order can't be charged twice. Oracle: at most one confirmed provider order (kind `order`) per paid order. |
| I4 | An **automatic** refund requires `dispute_state ∉ {open, lost}` and, for **every** attempt: never created (lookup by `external_id` → 404), `canceled` at the provider, or a `DELETE /v2/orders/{id}` that succeeded now (204, then 404). An attempt with `confirm_requested_at` and no answer is tried only after the quiet period (confirm timeout + 2 min). A refused delete turns the action into `alert`. |
| I5 | Attempt N+1 exists only after attempt N is proven cancelled or deleted, and N ≤ 3. |
| I6 | Fulfilment is followed (webhooks + reconciliation) until the order is complete (§2.7), independent of payment. |
| I7 | A **full** refund (or a shop-issued cancel) cancels fulfilment if still cancellable; otherwise it is recorded and Klaus is alerted, unless he issued it himself as "refund anyway". A partial refund is an event only. |
| I8 | The amount charged equals the quote's items + shipping (+ Stripe's tax). |
| I9 | At most one `checkout_open` order per cart (a unique index). |
| I10 | Every paid order that isn't complete has a runnable job, an open hold with a deadline, a refund in progress, or a confirmed attempt followed by reconciliation. |
| I11 | No provider order exists for an order without `failsafe_checked_at`. |

### 2.9 Test mode

In `test` mode the submit job creates the draft in the test store, waits for costs and
runs the cost guard; then `fulfilment_state = test_draft_ok` and the order is complete.
No hold, no alert, no automatic refund: Klaus inspects the draft and tries the admin and
Dashboard refunds himself ([12 §3](12-testing.md#3-against-the-real-services-before-go-live)). The nightly purge
deletes test-store drafts older than 7 days. In test mode the provider adapter has **no
confirm method**; `mock` mode confirms like `live`, so CI exercises the whole path.

### 2.10 Transitions in code

Each part changes with a conditional update (`… WHERE id = ? AND <part> = ?`) plus a
row in `order_events` in the same transaction; the loser of a race changes nothing and
re-reads. Facts without a state change (a partial refund, a dispute opened) are events
too.

## 3. Schema

SQLite via `node:sqlite`, WAL, `foreign_keys = ON`, numbered migrations, **two files**
(ADR-0029, review B F3):
- **`catalog.db`**, shared by all modes: works, display images, offers, print files and
  their registrations per provider **store**. Klaus's setup survives the switch to live.
- **`<mode>.db`** (`mock.db`, `test.db`, `live.db`): carts, quotes, orders and everything
  after them, jobs, settings. Test orders never meet live reconciliation.

SQLite can't enforce a foreign key across files: `order_items.print_file_sha` is a
checked value (checked at `POST /checkout`, asserted by reconciliation), and print files
referenced by any order item are never deleted (§6). Litestream replicates both files
([11 §3](11-operations.md#3-backup-and-restore)).

```sql
-- catalog.db ---------------------------------------------------------------
CREATE TABLE works (                      -- ADR-0035; only allow-listed fields
  source_id        TEXT NOT NULL,          -- 'art'; later e.g. 'christina-art', 'instagetter'
  work_id          TEXT NOT NULL,          -- the source's stable id (art: uid)
  title            TEXT NOT NULL,
  title_override   TEXT,                   -- set in the admin (sources with captions only)
  creator          TEXT, year TEXT,
  kind             TEXT,                   -- 'painting' | 'photograph' | …, drives wording
  canonical_url    TEXT NOT NULL, original_url TEXT NOT NULL,
  original_sha256  TEXT,                   -- set when fetched (only for works Klaus opens or enables)
  original_px_w    INTEGER, original_px_h INTEGER,
  source_version   TEXT,                   -- e.g. art's `v`; triggers a re-check, not a re-render
  prints_allowed   INTEGER NOT NULL,       -- consent: feed flag, source allow-list or source default
  enabled          INTEGER NOT NULL DEFAULT 0,
  seen_at          TEXT NOT NULL,
  PRIMARY KEY (source_id, work_id)
);
CREATE TABLE display_images (             -- rendered by the shop, no metadata
  sha256 TEXT PRIMARY KEY, source_id TEXT NOT NULL, work_id TEXT NOT NULL,
  width_px INTEGER NOT NULL, format TEXT NOT NULL, path TEXT NOT NULL
);
CREATE TABLE print_files (
  sha256 TEXT PRIMARY KEY,
  render_key TEXT NOT NULL UNIQUE,        -- source|work|original_sha256|sku|orientation|crop|renderer
  path TEXT NOT NULL, width_px INTEGER NOT NULL, height_px INTEGER NOT NULL, bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT                         -- file removed, row kept for order items
);
CREATE TABLE offers (
  source_id TEXT NOT NULL, work_id TEXT NOT NULL, sku_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  price_cents INTEGER,                    -- NULL = SKU default
  crop_json TEXT,                         -- anchor (one of 9) or a box; NULL = centred
  orientation TEXT,                       -- 'portrait' | 'landscape', from the work
  print_file_sha TEXT REFERENCES print_files(sha256),
  mockup_sha TEXT, effective_dpi INTEGER,
  PRIMARY KEY (source_id, work_id, sku_id),
  FOREIGN KEY (source_id, work_id) REFERENCES works(source_id, work_id)
);
CREATE TABLE provider_files (             -- one registration per provider store
  print_file_sha TEXT NOT NULL REFERENCES print_files(sha256),
  provider TEXT NOT NULL, store TEXT NOT NULL,   -- 'test' | 'live' (the store's id stays in configuration)
  provider_file_id TEXT,
  status TEXT NOT NULL,                   -- pending | waiting | ok | failed
  last_error TEXT, checked_at TEXT NOT NULL,
  PRIMARY KEY (print_file_sha, provider, store)
);

-- <mode>.db ----------------------------------------------------------------
CREATE TABLE carts (                      -- ADR-0026: any pictures
  id TEXT PRIMARY KEY,                    -- random cookie value
  quote_id TEXT,
  open_order_id TEXT,                     -- the checkout_open order, if any
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE cart_items (
  cart_id TEXT NOT NULL REFERENCES carts(id),
  source_id TEXT NOT NULL, work_id TEXT NOT NULL, sku_id TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity >= 1),   -- upper limits are configuration
  PRIMARY KEY (cart_id, source_id, work_id, sku_id)
);
CREATE TABLE quotes (                     -- the only place the address and e-mail live before payment
  id TEXT PRIMARY KEY, cart_id TEXT NOT NULL,
  items_json TEXT NOT NULL,               -- snapshot incl. unit prices
  email TEXT NOT NULL, address_json TEXT NOT NULL,
  options_json TEXT NOT NULL,             -- shipping options as quoted
  est_cost_cents INTEGER,                 -- pre-payment cost check (05 §2)
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,            -- 5 random digits (ADR-0032)
  payment_state TEXT NOT NULL,
  fulfilment_state TEXT NOT NULL DEFAULT 'none',
  dispute_state TEXT NOT NULL DEFAULT 'none',
  cart_id TEXT,
  email TEXT,                             -- PII, purged later
  ship_name TEXT, ship_line1 TEXT, ship_line2 TEXT, ship_city TEXT,
  ship_state TEXT, ship_zip TEXT, ship_country TEXT NOT NULL,
  shipping_method TEXT NOT NULL,
  shipping_cents INTEGER NOT NULL, items_cents INTEGER NOT NULL,
  tax_cents INTEGER, paid_cents INTEGER, refunded_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'usd',
  stripe_customer_id TEXT, stripe_session_id TEXT UNIQUE, stripe_payment_intent TEXT,
  checkout_idempotency_key TEXT NOT NULL, -- §2.1.1
  card_fingerprint TEXT, radar_risk_level TEXT,     -- fail-safe inputs (absent for some methods)
  failsafe_checked_at TEXT,                         -- I11
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  paid_at TEXT, completed_at TEXT, purged_at TEXT
);
CREATE UNIQUE INDEX one_open_checkout_per_cart ON orders(cart_id) WHERE payment_state = 'checkout_open';  -- I9

CREATE TABLE order_items (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id),
  source_id TEXT NOT NULL, work_id TEXT NOT NULL, sku_id TEXT NOT NULL,
  name TEXT NOT NULL,                     -- frozen copy for display
  provider TEXT NOT NULL, provider_variant_id INTEGER NOT NULL,
  unit_cents INTEGER NOT NULL, tax_cents INTEGER,   -- from Stripe's line item (its metadata carries this id)
  quantity INTEGER NOT NULL CHECK (quantity >= 1),
  print_file_sha TEXT NOT NULL            -- catalog.db print_files.sha256, checked in code
);

CREATE TABLE refunds (                    -- review A F3
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id),
  purpose TEXT NOT NULL,                  -- cancel | anyway | deadline | fraud | dashboard
  amount_cents INTEGER NOT NULL,
  state TEXT NOT NULL,                    -- requested | succeeded | failed
  stripe_refund_id TEXT, requested_at TEXT NOT NULL, requested_by TEXT NOT NULL,
  finished_at TEXT, last_error TEXT
);

CREATE TABLE order_events (               -- append-only history of every change and fact
  id INTEGER PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id),
  part TEXT NOT NULL,                     -- payment | fulfilment | dispute | hold | refund | email | note
  attempt INTEGER,                        -- for provider events
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

CREATE TABLE provider_orders (            -- one row per attempt (or linked reshipment)
  order_id TEXT NOT NULL REFERENCES orders(id), provider TEXT NOT NULL, attempt INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'order',     -- order | reship
  external_id TEXT NOT NULL UNIQUE, provider_order_id TEXT,
  state TEXT NOT NULL,                    -- submitting | draft | confirming | confirmed | canceled | deleted | failed
  confirm_requested_at TEXT, confirm_tries INTEGER NOT NULL DEFAULT 0,   -- I3
  override_by TEXT, override_at TEXT,     -- "confirm anyway"
  status TEXT, costs_json TEXT, last_error TEXT, updated_at TEXT NOT NULL,
  PRIMARY KEY (order_id, provider, attempt)
);

CREATE TABLE shipments (
  provider TEXT NOT NULL, id TEXT NOT NULL,
  order_id TEXT NOT NULL REFERENCES orders(id), attempt INTEGER NOT NULL,
  carrier TEXT, service TEXT, tracking_number TEXT, tracking_url TEXT,
  shipped_at TEXT, delivered_at TEXT,
  estimated_from TEXT, estimated_to TEXT,
  shipment_status TEXT, delivery_status TEXT,   -- as the provider reports them
  is_reshipment INTEGER NOT NULL DEFAULT 0, items_json TEXT NOT NULL,
  PRIMARY KEY (provider, id)
);

CREATE TABLE inbound_events (
  provider TEXT NOT NULL, event_id TEXT NOT NULL, type TEXT NOT NULL,
  object_id TEXT,                         -- Stripe: data.object.id; the rest is re-fetched
  payload_json TEXT,                      -- Printful only: raw body + signature headers (no customer data); 30 days
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
  ref TEXT NOT NULL DEFAULT '',                 -- shipment id for 'shipped'; request id for 'link' and admin resends
  sent_at TEXT, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
  PRIMARY KEY (order_id, kind, ref)
);

CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT);
  -- includes breaker_reset_at and the runner's heartbeat (11 §4)
CREATE TABLE reconciliation_runs (id INTEGER PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT, report_json TEXT, alarms INTEGER NOT NULL DEFAULT 0);
CREATE TABLE admin_audit (id INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT, details_json TEXT);
```

## 4. Jobs

- One in-process runner leases the oldest due job (`run_after <= now`, lease 5 min), runs it, then marks it done, re-queues it with backoff, or fails it after its kind's limit. Expired leases are picked up again; every job is idempotent.
- At most one open job per (kind, key).
- Every outbound call has a timeout; the runner writes a heartbeat every tick (`/health/worker`, [11 §4](11-operations.md#4-observability)).
- Printful-calling jobs run one at a time; they pause when `X-Ratelimit-Remaining` is low, and while the provider is "unverified" after a start without an answer ([06 §3](06-fulfilment.md#3-printful-adapter)).
- All times come from a `Clock` interface (no direct `Date.now()`; a lint rule), so tests control time.
- Kinds: `payment.apply` (§2.1), `order.submit`, `order.cancel`, `refund`, `stripe.event`, `printful.event`, `printfile.render`, `printfile.register`, `display.render`, `mockup.create`, `email.send`, `reconcile`, `catalog.refresh`, `sources.refresh`, `purge`, `backup.check`.

## 5. Reconciliation

Hourly, and on demand (dry-run available). **Forward** (from local rows):
1. `checkout_open` past expiry + 30 min: re-fetch; paid → `payment.apply`; expired → `closed_unpaid`; no session id → §2.1.1.
2. Paid without `failsafe_checked_at`: `payment.apply` (never a submit). Paid, checked, fulfilment `none`, no open hold, no open job for > 15 min: enqueue submit.
3. Every order that isn't complete and has a confirmed attempt: re-fetch the provider order and shipments; apply (I6); set `completed_at` when §2.7 holds.
4. `confirming` attempts past the quiet period: re-read; confirmed → `submitted`; `draft` → confirm again (I3, at most 3 tries, then an `attention` hold).
5. Refunds and disputes of the last 90 days that the shop hasn't recorded; `requested` refunds older than 1 h: re-read at Stripe.
6. Holds past their deadline: apply `deadline_action` (I4 for refunds).
7. Unprocessed inbound events older than 10 min: re-run.
8. Unsent e-mails with attempts < 5: retry.
9. I10: a paid, incomplete order with no job, no open hold, no refund in progress and no confirmed attempt gets an `attention` hold (`fulfilment_blocked`).

**Reverse** (review 1 F15): list the provider's recent orders (last 100) and Stripe's paid
Checkout Sessions of the last 7 days.
- A paid session whose local order exists but isn't paid: apply it (I1), no alarm.
- A provider order with an unknown `external_id`, a paid session without a local order,
  or a mismatching state: an **alarm**. For an unknown provider order the alarm offers
  "link to order N as a reshipment" (§2.4). The sweep never rebuilds rows (after a
  restore, Klaus decides per alarm).

Report stored in `reconciliation_runs`; an e-mail to Klaus only when there are alarms.

## 6. Retention and purge

| Data | Kept |
|---|---|
| Orders, items, events, amounts | 10 years (accounting and tax records) |
| Name, e-mail, address on orders | Until **180 days** after `completed_at` (covers chargebacks), then `NULL` (country and state kept); `purged_at` set |
| Stripe Customer objects | Deleted by the purge job at the same time (they hold name and address; Stripe keeps them on the payment records, [10](10-security-privacy-legal.md)) |
| `inbound_events.payload_json` (Printful only) | 30 days |
| Carts, quotes (with the e-mail and address) | 30 days, 7 days |
| Orders never paid | **deleted** after 7 days, with their Stripe Customer; the number is freed |
| Print files | file deleted (row kept, `deleted_at`) when no offer references it and no order item of the last 12 months does; the purge runs in `live` mode only and checks `live.db`, so a test purge can't remove a live order's file |
| Display images | while their work is listed |
| Test-store drafts (test mode) | deleted after 7 days |
| Jobs done | 30 days |
| Backups | Litestream 30 days, nightly copies as in [11 §3](11-operations.md#3-backup-and-restore): purged data survives there until they age out |
