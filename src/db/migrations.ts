/**
 * Numbered migrations for the two database files (docs/design/07 §3, ADR-0029).
 * Migration N brings a file from `PRAGMA user_version = N-1` to N. Never edit a
 * migration that has shipped; add the next one.
 *
 * catalog.db is shared by all modes; <mode>.db holds everything from the cart on.
 * There is no foreign key between the two files: order_items.print_file_sha is
 * checked in code.
 */

export const CATALOG_MIGRATIONS: string[] = [
  // 1: the round-2 schema
  `
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
  source_version   TEXT,                   -- e.g. art's 'v'; triggers a re-check, not a re-render
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
`,
  // 2: works no longer listed by their source are hidden, not deleted (04 §4.5);
  // display images carry their height for width/height attributes.
  `
ALTER TABLE works ADD COLUMN listed INTEGER NOT NULL DEFAULT 1;
ALTER TABLE display_images ADD COLUMN height_px INTEGER NOT NULL DEFAULT 0;
CREATE INDEX display_images_work ON display_images(source_id, work_id);
`,
  // 3: the daily catalog check per SKU (docs/design/04 §2): the last good answer
  // is kept when Printful doesn't answer; a mismatch disables the SKU.
  `
CREATE TABLE sku_checks (
  sku_id TEXT PRIMARY KEY,
  ok INTEGER NOT NULL,
  wholesale_cents INTEGER,
  problem TEXT,
  checked_at TEXT NOT NULL
);
`,
  // 4: a small preview of each print file for the admin (what will be printed),
  // the share of the picture the crop cuts, and render failures.
  `
ALTER TABLE print_files ADD COLUMN preview_path TEXT;
ALTER TABLE offers ADD COLUMN cut_pct INTEGER;
ALTER TABLE offers ADD COLUMN render_error TEXT;
`,
  // 5: mockups (docs/design/04 §7): the task at Printful and the print file it shows.
  `
ALTER TABLE offers ADD COLUMN mockup_task_id TEXT;
ALTER TABLE offers ADD COLUMN mockup_for TEXT;
`,
];

export const MODE_MIGRATIONS: string[] = [
  // 1: the round-2 schema
  `
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
`,
  // 2: the quote a checkout was started from, so "Pay" again reuses the same session (05 §3 step 1).
  `
ALTER TABLE orders ADD COLUMN checkout_quote_id TEXT;
`,
  // 3: the orientation sent to Printful with each item (06 §3), frozen at checkout.
  `
ALTER TABLE order_items ADD COLUMN orientation TEXT;
`,
  // 4: indexes for the lookups that run all the time: the runner's lease every few
  // seconds, and an order's rows on every order page, webhook and sweep.
  `
CREATE INDEX jobs_due ON jobs(state, run_after);
CREATE INDEX order_items_order ON order_items(order_id);
CREATE INDEX order_events_order ON order_events(order_id);
CREATE INDEX refunds_order ON refunds(order_id);
CREATE INDEX shipments_order ON shipments(order_id);
CREATE INDEX orders_payment_intent ON orders(stripe_payment_intent);
`,
];
