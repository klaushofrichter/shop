/**
 * Mock Printful (docs/design/14 §4, §10): identity, catalog, shipping rates,
 * the file library, mockups, orders (draft, costs, confirm, delete, cancel),
 * shipments, signed webhooks, rate-limit headers and the control API.
 *
 * Shapes follow the 2026-11-24 captures; requests are validated against the
 * pinned v2 spec and unknown fields are refused (14 §7.1). Mock tokens start
 * with `mock_printful_`; anything else gets Printful's 401.
 */
import express, { type Express, type Request, type Response } from 'express';
import { createHmac } from 'node:crypto';
import sharp from 'sharp';
import type { Clock } from '../../src/clock';
import { MOCK_VARIANTS, SHIP_RATES, US_STATES, type MockVariant } from './catalog';
import { PrintfulSpec } from './spec';

export const MOCK_STORE = { id: 10000001, name: 'mock store', type: 'native' };
const FILE_PROCESSING_MS = 5_000;
/** Captured: ~20 s from pending to completed. Printful allows 2–10 tasks a minute; the mock allows 10. */
const MOCKUP_MS = 20_000;
const MOCKUPS_PER_MINUTE = 10;

interface MockFile {
  id: number;
  url: string;
  visible: boolean;
  created: number;
  outcome: 'ok' | 'failed';
}

export interface Scenario {
  /** Answer the next n requests (any route) with this status. */
  status?: { code: number; count: number; retryAfterS?: number };
  /** File URLs containing this text end `failed`. */
  failFilesMatching?: string;
  /** Mockup tasks end `failed`. */
  failMockups?: boolean;
  /** The next order create is refused like a bad address (400 "Recipient: …"). */
  refuseNextOrder?: boolean;
  /** The next order create is made, but the answer is a 500 (the shop must look it up). */
  loseNextCreateAnswer?: boolean;
  /** The next confirm is made, but the answer is a 500. */
  loseNextConfirmAnswer?: boolean;
  /** Cost calculation of new orders ends `failed`. */
  failCosts?: boolean;
  /** Multiply the item costs of new orders (to trip the shop's cost guard). */
  costFactor?: number;
}

export interface MockOrder {
  id: number;
  externalId: string | null;
  status: string;
  created: number;
  shipping: string;
  body: Record<string, unknown>;
  itemsCents: number;
  shippingCents: number;
  costsFail: boolean;
  confirmedAt?: number;
  canceledBy?: 'shop' | 'printful';
  shipments: MockShipment[];
}

export interface MockShipment {
  id: number;
  status: string;
  delivery: string;
  /** Unset while the parcel is `pending` (Printful lists shipments before they ship). */
  shippedAt?: number;
  deliveredAt?: number;
}

/** Where and how the mock sends webhooks (06 §3); target is read at send time. */
export interface MockWebhookConfig {
  target: string;
  secretHex: string;
  publicKey: string;
}

interface MockMockup {
  id: number;
  created: number;
  variantId: number;
  placement: string;
  failed: boolean;
}

export interface MockPrintful {
  app: Express;
  reset(): void;
  scenario(s: Scenario): void;
  /** Every request received, for assertions. */
  requests: Array<{ method: string; path: string; body: unknown }>;
  files: Map<number, MockFile>;
  orders: Map<number, MockOrder>;
  /** Move an order along as Printful would, sending its webhook. */
  advance(id: number, status: string): Promise<void>;
  /** Ship every item in one parcel: `fulfilled`, `shipment_sent`. Returns the shipment id. */
  ship(id: number): Promise<number>;
  deliver(shipmentId: number): Promise<void>;
  /** Send an event as Printful would (used by the scenarios above). */
  emit(type: string, o: MockOrder, sh?: MockShipment): Promise<number | 'error'>;
}

let spec: PrintfulSpec | undefined;

export function createMockPrintful(opts: { clock: Clock & { advance?(ms: number): void }; webhook?: MockWebhookConfig }): MockPrintful {
  spec ??= new PrintfulSpec();
  const { clock } = opts;
  const state = {
    files: new Map<number, MockFile>(),
    nextFileId: 900000001,
    scenario: {} as Scenario,
    requests: [] as Array<{ method: string; path: string; body: unknown }>,
    remaining: 120,
    mockups: new Map<number, MockMockup>(),
    nextMockupId: 700000001,
    orders: new Map<number, MockOrder>(),
    nextOrderId: 150000001,
  };
  const variants = new Map(MOCK_VARIANTS.map((v) => [v.id, v]));
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  const send = (res: Response, status: number, body: unknown) => res.status(status).json(body);
  const fail = (res: Response, status: number, reason: string, message: string) => send(res, status, { data: message, error: { reason, message } });

  // ---- control API (never routed publicly) ----
  app.post('/__mock/reset', (_req, res) => {
    reset();
    res.json({ ok: true });
  });
  app.post('/__mock/scenario', (req, res) => {
    state.scenario = { ...state.scenario, ...(req.body as Scenario) };
    res.json({ ok: true });
  });
  app.post('/__mock/orders/:id/advance', async (req, res) => {
    if (!state.orders.has(Number(req.params.id))) return res.status(404).json({ error: 'no such order' });
    await advance(Number(req.params.id), String((req.body as { status?: string }).status));
    res.json({ ok: true });
  });
  app.post('/__mock/orders/:id/ship', async (req, res) => {
    if (!state.orders.has(Number(req.params.id))) return res.status(404).json({ error: 'no such order' });
    res.json({ shipment: await ship(Number(req.params.id)) });
  });
  app.post('/__mock/shipments/:id/deliver', async (req, res) => {
    await deliver(Number(req.params.id));
    res.json({ ok: true });
  });
  app.get('/__mock/orders', (_req, res) => res.json([...state.orders.values()].map((o) => ({ id: o.id, external_id: o.externalId, status: o.status }))));
  app.post('/__mock/clock/advance', (req, res) => {
    if (!opts.clock.advance) return res.status(409).json({ error: 'this clock cannot be moved' });
    opts.clock.advance(Number((req.body as { ms?: number }).ms) || 0);
    res.json({ now: new Date(clock.now()).toISOString() });
  });
  app.get('/__mock/requests', (_req, res) => res.json(state.requests));
  // The finished mockup images (Printful serves them from a temporary S3 URL).
  app.get('/__mock/mockup-images/:id.jpg', async (req, res) => {
    const m = state.mockups.get(Number(req.params.id));
    if (!m) return res.status(404).end();
    const img = await sharp({ create: { width: 1000, height: 1000, channels: 3, background: { r: 230, g: 228, b: 222 } } })
      .withExifMerge({ IFD0: { Software: 'mock printful' } })
      .jpeg()
      .toBuffer();
    res.type('image/jpeg').send(img);
  });

  // ---- every API call: record, authenticate, rate-limit headers, scenario, spec ----
  app.use((req, res, next) => {
    if (req.path.startsWith('/__mock')) return next();
    state.requests.push({ method: req.method, path: req.originalUrl, body: req.body });
    state.remaining = Math.max(0, state.remaining - 1);
    res.setHeader('x-ratelimit-limit', '120');
    res.setHeader('x-ratelimit-policy', '120;w=60;');
    res.setHeader('x-ratelimit-remaining', String(state.remaining));
    res.setHeader('x-ratelimit-reset', '0.5');
    const auth = req.get('authorization') ?? '';
    if (!/^Bearer mock_printful_[A-Za-z0-9_-]+$/.test(auth)) {
      return fail(res, 401, 'Unauthorized', 'The access token provided is invalid.');
    }
    const st = state.scenario.status;
    if (st && st.count > 0) {
      st.count--;
      if (st.retryAfterS) res.setHeader('retry-after', String(st.retryAfterS));
      return fail(res, st.code, st.code === 429 ? 'TooManyRequests' : 'InternalServerError', `mock scenario ${st.code}`);
    }
    if (req.method === 'POST' && spec!.knows(req.method, req.path)) {
      const errors = spec!.validateRequest(req.method, req.path, req.body);
      if (errors.length) {
        // Printful's own type errors read like this (captured); unknown fields
        // are the mock's stricter addition.
        const typeErr = errors.find((e) => / must be integer$/.test(e));
        const msg = typeErr
          ? `Property \`${typeErr.split(' ')[0]}\` must be of type \`int\`, \`string\` provided`
          : `mock: request doesn't match the spec: ${errors.slice(0, 5).join('; ')}`;
        return fail(res, 400, 'BadRequest', msg);
      }
    }
    next();
  });

  // ---- identity ----
  app.get('/v2/stores', (_req, res) =>
    send(res, 200, { data: [MOCK_STORE], extra: [], paging: { total: 1, limit: 20, offset: 0 }, _links: { self: { href: 'https://api.printful.com/v2/stores?limit=20' } } }),
  );
  app.get('/v2/oauth-scopes', (_req, res) =>
    send(res, 200, {
      data: [
        ['View orders of the authorized store', 'orders/read'],
        ['View and manage orders of the authorized store', 'orders'],
        ['View store products', 'sync_products/read'],
        ['View and manage store products', 'sync_products'],
        ['View store files', 'file_library/read'],
        ['View and manage store files', 'file_library'],
        ['View store webhooks', 'webhooks/read'],
        ['View and manage store webhooks', 'webhooks'],
      ].map(([name, value]) => ({ name, value })),
      _links: { self: { href: 'https://api.printful.com/v2/oauth-scopes' } },
    }),
  );

  // ---- catalog ----
  const variant = (req: Request, res: Response): MockVariant | undefined => {
    const v = variants.get(Number(req.params.id));
    if (!v) fail(res, 404, 'NotFound', 'Not Found');
    return v;
  };
  app.get('/v2/catalog-variants/:id', (req, res) => {
    const v = variant(req, res);
    if (!v) return;
    send(res, 200, {
      data: {
        id: v.id, catalog_product_id: v.productId, name: v.name, size: v.size, color: null, color_code: null, color_code2: null,
        image: `https://files.cdn.printful.com/products/${v.productId}/${v.id}.jpg`,
        placement_dimensions: v.placements,
        _links: {},
      },
      extra: [],
    });
  });
  app.get('/v2/catalog-variants/:id/prices', (req, res) => {
    const v = variant(req, res);
    if (!v) return;
    send(res, 200, {
      data: {
        currency: 'USD',
        product: { id: v.productId, placements: [] },
        variant: { id: v.id, techniques: [{ technique_key: v.technique, technique_display_name: v.technique, price: v.price, discounted_price: v.price }] },
        discount_tiers: [],
      },
      extra: [],
      _links: {},
    });
  });
  app.get('/v2/catalog-variants/:id/availability', (req, res) => {
    const v = variant(req, res);
    if (!v) return;
    send(res, 200, {
      data: { catalog_variant_id: v.id, techniques: [{ technique: v.technique, selling_regions: [{ name: 'usa', availability: 'in stock', placement_option_availability: [] }] }] },
      extra: [],
      _links: {},
    });
  });

  // ---- shipping rates: captured validation order and messages ----
  app.post('/v2/shipping-rates', (req, res) => {
    const body = req.body as { recipient: Record<string, string>; order_items: Array<{ catalog_variant_id: number; quantity: number }> };
    const r = body.recipient;
    if (r.country_code !== 'US') return fail(res, 400, 'BadRequest', 'mock: only US recipients');
    if (!r.state_code) return fail(res, 400, 'BadRequest', 'State code is missing');
    if (!US_STATES.has(r.state_code)) return fail(res, 400, 'BadRequest', `Invalid state \`${r.state_code}\` select a valid state for country \`US\``);
    const items: Array<{ v: MockVariant; q: number }> = [];
    for (const i of body.order_items) {
      const v = variants.get(i.catalog_variant_id);
      if (!v) return fail(res, 404, 'NotFound', `Variant with ID: ${i.catalog_variant_id} does not exist.`);
      items.push({ v, q: i.quantity });
    }
    // Apparel and mugs ship from another facility than paper: two parcels.
    const groups = new Map<string, typeof items>();
    for (const it of items) {
      const g = it.v.ship === 'apparel' || it.v.ship === 'mug' ? 'b' : 'a';
      groups.set(g, [...(groups.get(g) ?? []), it]);
    }
    let cents = 0;
    for (const g of groups.values()) {
      const sorted = [...g].sort((x, y) => SHIP_RATES[y.v.ship][0] - SHIP_RATES[x.v.ship][0]);
      sorted.forEach((it, i) => {
        const [first, extra] = SHIP_RATES[it.v.ship];
        cents += (i === 0 ? first : extra) + extra * (it.q - 1);
      });
    }
    if (r.state_code === 'AK' || r.state_code === 'HI') cents += 400;
    const days = groups.size > 1 ? [10, 11] : [4, 6];
    const date = (d: number) => new Date(clock.now() + d * 86_400_000).toISOString().slice(0, 10);
    const shipments = [...groups.values()].map((g) => ({
      departure_country: 'US',
      shipment_items: g.map((it) => ({ catalog_variant_id: it.v.id, quantity: it.q })),
      customs_fees_possible: false,
    }));
    const rate = (method: string, name: string, c: number) => ({
      shipping: method,
      shipping_method_name: `${name} (Estimated delivery: ${date(days[0])}–${date(days[1])}) `,
      rate: (c / 100).toFixed(2),
      currency: 'USD',
      min_delivery_days: days[0],
      max_delivery_days: days[1],
      min_delivery_date: date(days[0]),
      max_delivery_date: date(days[1]),
      shipments,
    });
    send(res, 200, { data: [rate('STANDARD', 'Flat Rate', cents), rate('STANDARD_CARBON_OFFSET', 'Flat Rate, carbon offset', cents + 12)], extra: [] });
  });

  // ---- file library: waiting → ok/failed after a few seconds of mock time; de-duplicated by URL ----
  const fileBody = (f: MockFile) => {
    const done = clock.now() - f.created >= FILE_PROCESSING_MS;
    const status = done ? f.outcome : 'waiting';
    const ok = status === 'ok';
    return {
      id: f.id, url: f.url, hash: ok ? `mockhash${f.id}` : null, filename: ok ? f.url.split('/').pop() : null,
      mime_type: ok ? 'image/jpeg' : null, size: ok ? 1_000_000 : 0, width: ok ? 3600 : null, height: ok ? 4800 : null, dpi: null,
      status, created: new Date(f.created).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      thumbnail_url: null, preview_url: null, visible: f.visible, is_temporary: false, _links: { self: { href: `https://api.printful.com/v2/files/${f.id}` } },
    };
  };
  app.post('/v2/files', (req, res) => {
    const { url, visible } = req.body as { url: string; visible?: boolean };
    let f = [...state.files.values()].find((x) => x.url === url);
    if (!f) {
      const failing = state.scenario.failFilesMatching;
      f = { id: state.nextFileId++, url, visible: visible !== false, created: clock.now(), outcome: failing && url.includes(failing) ? 'failed' : 'ok' };
      state.files.set(f.id, f);
    }
    send(res, 200, { data: fileBody(f), extra: [] });
  });
  app.get('/v2/files/:id', (req, res) => {
    const f = state.files.get(Number(req.params.id));
    if (!f) return fail(res, 404, 'NotFound', 'Not found');
    send(res, 200, { data: fileBody(f), extra: [] });
  });
  // Library entries can't be deleted through the API (captured).
  app.delete('/v2/files/:id', (_req, res) => fail(res, 404, 'NotFound', 'Not found'));

  // ---- mockup tasks: pending → completed after ~20 s of mock time ----
  const mockupBody = (req: Request, m: MockMockup) => {
    const done = clock.now() - m.created >= MOCKUP_MS;
    const status = !done ? 'pending' : m.failed ? 'failed' : 'completed';
    return {
      id: m.id,
      status,
      catalog_variant_mockups:
        status === 'completed'
          ? [{ catalog_variant_id: m.variantId, mockups: [{ placement: m.placement, display_name: 'Print file', technique: 'digital', style_id: 1, mockup_url: `${req.protocol}://${req.get('host')}/__mock/mockup-images/${m.id}.jpg`, view: 'Front' }] }]
          : [],
      failure_reasons: status === 'failed' ? [{ type: 'mock', message: 'mock scenario: mockup failed' }] : [],
      _links: { self: { href: `https://api.printful.com/v2/mockup-tasks?id=${m.id}` } },
    };
  };
  app.post('/v2/mockup-tasks', (req, res) => {
    const recent = [...state.mockups.values()].filter((m) => clock.now() - m.created < 60_000).length;
    if (recent >= MOCKUPS_PER_MINUTE) {
      res.setHeader('retry-after', '60');
      return fail(res, 429, 'TooManyRequests', 'Too many mockup tasks, try again later.');
    }
    const p = (req.body as { products: Array<{ catalog_variant_ids?: number[]; placements?: Array<{ placement: string }> }> }).products[0];
    const variantId = p?.catalog_variant_ids?.[0];
    if (!variantId || !variants.has(variantId)) return fail(res, 404, 'NotFound', `Variant with ID: ${variantId} does not exist.`);
    const m: MockMockup = { id: state.nextMockupId++, created: clock.now(), variantId, placement: p.placements?.[0]?.placement ?? 'default', failed: !!state.scenario.failMockups };
    state.mockups.set(m.id, m);
    send(res, 200, { data: [mockupBody(req, m)], extra: [] });
  });
  app.get('/v2/mockup-tasks', (req, res) => {
    const m = state.mockups.get(Number(req.query.id));
    send(res, 200, { data: m ? [mockupBody(req, m)] : [], extra: [], paging: { total: m ? 1 : 0, limit: 20, offset: 0 }, _links: {} });
  });

  // ---- orders (06 §3, 14 §4 stage 3): draft → costs after ~2 s → confirm → pending ----
  const COSTS_MS = 2_000;
  const money = (c: number) => (c / 100).toFixed(2);
  const orderBody = (o: MockOrder) => {
    const done = clock.now() - o.created >= COSTS_MS;
    const cs = !done ? 'calculating' : o.costsFail ? 'failed' : 'done';
    const tax = Math.round(o.itemsCents * 0.0825);
    const n = (c: number) => (cs === 'done' ? money(c) : null);
    const b = o.body as { recipient: unknown; order_items: Array<Record<string, unknown>>; customization?: unknown; retail_costs?: Record<string, string> };
    return {
      id: o.id, external_id: o.externalId, store_id: MOCK_STORE.id, shipping: o.shipping, status: o.status,
      created_at: new Date(o.created).toISOString(), updated_at: new Date(clock.now()).toISOString(),
      recipient: b.recipient,
      costs: {
        calculation_status: cs, currency: 'USD', subtotal: n(o.itemsCents), discount: n(0), shipping: n(o.shippingCents), digitization: n(0),
        additional_fee: n(0), fulfillment_fee: n(0), retail_delivery_fee: n(0), vat: n(0), tax: n(tax), total: n(o.itemsCents + o.shippingCents + tax),
      },
      retail_costs: { calculation_status: cs, currency: 'USD', subtotal: null, discount: null, shipping: b.retail_costs?.shipping ?? null, tax: b.retail_costs?.tax ?? null, vat: null, total: null },
      order_items: b.order_items.map((i, k) => ({ id: o.id * 10 + k, ...i })),
      customization: b.customization ?? null,
      _links: { self: { href: `https://api.printful.com/v2/orders/${o.id}` } },
    };
  };
  const findOrder = (ref: string) =>
    ref.startsWith('@') ? [...state.orders.values()].find((o) => o.externalId === decodeURIComponent(ref.slice(1))) : state.orders.get(Number(ref));

  app.post('/v2/orders', (req, res) => {
    const b = req.body as { external_id?: string; shipping?: string; recipient: Record<string, string>; order_items: Array<{ catalog_variant_id: number; quantity: number }> };
    if (b.external_id && [...state.orders.values()].some((o) => o.externalId === b.external_id)) {
      return fail(res, 400, 'BadRequest', 'External ID validation error: Order with this external ID already exists.');
    }
    if (state.scenario.refuseNextOrder) {
      state.scenario.refuseNextOrder = false;
      return fail(res, 400, 'BadRequest', 'Recipient: The address could not be verified.');
    }
    if (!US_STATES.has(b.recipient?.state_code)) return fail(res, 400, 'BadRequest', `Recipient: Invalid state \`${b.recipient?.state_code}\``);
    let items = 0;
    let shipping = 0;
    for (const [k, i] of b.order_items.entries()) {
      const v = variants.get(i.catalog_variant_id);
      if (!v) return fail(res, 404, 'NotFound', `Variant with ID: ${i.catalog_variant_id} does not exist.`);
      items += Math.round(Number(v.price) * 100 * (state.scenario.costFactor ?? 1)) * i.quantity;
      const [first, extra] = SHIP_RATES[v.ship];
      shipping += k === 0 ? first + extra * (i.quantity - 1) : extra * i.quantity;
    }
    const o: MockOrder = {
      id: state.nextOrderId++, externalId: b.external_id ?? null, status: 'draft', created: clock.now(), shipping: b.shipping ?? 'STANDARD',
      body: req.body as Record<string, unknown>, itemsCents: items, shippingCents: shipping, costsFail: !!state.scenario.failCosts, shipments: [],
    };
    state.orders.set(o.id, o);
    if (state.scenario.loseNextCreateAnswer) {
      state.scenario.loseNextCreateAnswer = false;
      return fail(res, 500, 'InternalServerError', 'mock scenario: answer lost');
    }
    send(res, 200, { data: orderBody(o), extra: [] });
  });
  app.get('/v2/orders', (req, res) => {
    const limit = Math.min(100, Number(req.query.limit) || 20);
    const list = [...state.orders.values()].sort((a, b) => b.id - a.id).slice(0, limit);
    send(res, 200, { data: list.map(orderBody), extra: [], paging: { total: state.orders.size, limit, offset: 0 }, _links: {} });
  });
  app.get('/v2/orders/:ref', (req, res) => {
    const o = findOrder(String(req.params.ref));
    if (!o) return fail(res, 404, 'NotFound', 'Order not found');
    send(res, 200, { data: orderBody(o), extra: [] });
  });
  app.post('/v2/orders/:ref/confirmation', (req, res) => {
    const o = findOrder(String(req.params.ref));
    if (!o) return fail(res, 404, 'NotFound', 'Order not found');
    if (o.status !== 'draft') return fail(res, 400, 'BadRequest', `Order with status ${o.status} cannot be confirmed`);
    if (clock.now() - o.created < COSTS_MS || o.costsFail) return fail(res, 400, 'BadRequest', 'Order costs are not calculated');
    o.status = 'pending';
    o.confirmedAt = clock.now();
    // Printful may list a shipment before it ships (review F2): the parcel exists as `pending` from now on.
    o.shipments.push({ id: nextShipmentId++, status: 'pending', delivery: 'unknown' });
    if (state.scenario.loseNextConfirmAnswer) {
      state.scenario.loseNextConfirmAnswer = false;
      return fail(res, 500, 'InternalServerError', 'mock scenario: answer lost');
    }
    send(res, 200, { data: orderBody(o), extra: [] });
  });
  // v2 delete: only orders that were never charged (draft, failed, canceled before a charge).
  app.delete('/v2/orders/:ref', (req, res) => {
    const o = findOrder(String(req.params.ref));
    if (!o) return fail(res, 404, 'NotFound', 'Order not found');
    if (!['draft', 'failed', 'canceled'].includes(o.status) || o.confirmedAt) return fail(res, 400, 'BadRequest', 'This order cannot be deleted');
    state.orders.delete(o.id);
    res.status(204).end();
  });
  // v1 cancel: confirmed orders not yet in production; they stay visible as canceled.
  app.delete('/orders/:ref', (req, res) => {
    const o = findOrder(String(req.params.ref));
    if (!o) return res.status(404).json({ code: 404, result: 'Order not found', error: { reason: 'NotFound', message: 'Order not found' } });
    if (!['draft', 'pending', 'inreview', 'failed', 'onhold'].includes(o.status)) {
      return res.status(400).json({ code: 400, result: 'Order cannot be canceled', error: { reason: 'BadRequest', message: 'Order cannot be canceled' } });
    }
    o.status = 'canceled';
    o.canceledBy = 'shop';
    res.json({ code: 200, result: { id: o.id, status: 'canceled' } });
    void emit('order_canceled', o);
  });
  app.get('/v2/orders/:ref/shipments', (req, res) => {
    const o = findOrder(String(req.params.ref));
    if (!o) return fail(res, 404, 'NotFound', 'Order not found');
    send(res, 200, { data: o.shipments.map((sh) => shipmentBody(o, sh)), extra: [], paging: { total: o.shipments.length, limit: 100, offset: 0 }, _links: {} });
  });

  // ---- webhooks (06 §3): signed deliveries, shipment details only via the API ----
  const isoS = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const shipmentBody = (o: MockOrder, sh: MockShipment) => ({
    id: sh.id, order_id: o.id, order_external_id: o.externalId, carrier: 'USPS', service: 'USPS Ground Advantage',
    shipment_status: sh.status, shipped_at: sh.shippedAt ? isoS(sh.shippedAt) : null, delivery_status: sh.delivery, delivered_at: sh.deliveredAt ? isoS(sh.deliveredAt) : null,
    departure_address: { country_name: 'United States', country_code: 'US', state_code: 'NC' }, is_reshipment: false,
    tracking_number: `9400000000000${sh.id}`, tracking_url: `https://tools.usps.com/go/TrackConfirmAction?tLabels=9400000000000${sh.id}`,
    tracking_events: [], estimated_delivery: sh.shippedAt ? { from_date: isoS(sh.shippedAt + 2 * 86_400_000).slice(0, 10), to_date: isoS(sh.shippedAt + 5 * 86_400_000).slice(0, 10), calculated_at: isoS(sh.shippedAt) } : null,
    shipment_items: ((o.body.order_items ?? []) as Array<{ external_id?: string; quantity: number }>).map((i, k) => ({ id: o.id * 10 + k, order_item_id: o.id * 10 + k, order_item_external_id: i.external_id ?? null, quantity: i.quantity })),
    _links: { self: { href: `https://api.printful.com/v2/shipments/${sh.id}` } },
  });
  let nextShipmentId = 41000001;
  async function emit(type: string, o: MockOrder, sh?: MockShipment): Promise<number | 'error'> {
    const w = opts.webhook;
    if (!w?.target) return 'error';
    const body = Buffer.from(JSON.stringify({
      type, occurred_at: isoS(clock.now()), retries: 0, store_id: MOCK_STORE.id,
      data: {
        order: { id: o.id, external_id: o.externalId, status: o.status, store_id: MOCK_STORE.id, dashboard_url: `https://www.printful.com/dashboard?order_id=${o.id}`, created_at: isoS(o.created), updated_at: isoS(clock.now()) },
        ...(sh ? { shipment: { id: sh.id, shipment_status: sh.status, delivery_status: sh.delivery } } : {}),
      },
    }));
    const signature = createHmac('sha256', Buffer.from(w.secretHex, 'hex')).update(body).digest('hex');
    try {
      const r = await fetch(w.target, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pf-webhook-signature': signature, 'x-pf-webhook-public-key': w.publicKey }, body });
      return r.status;
    } catch {
      return 'error';
    }
  }
  const EVENT_FOR: Record<string, string> = { inprocess: 'order_updated', pending: 'order_updated', canceled: 'order_canceled', failed: 'order_failed', onhold: 'order_put_hold' };
  async function advance(id: number, status: string) {
    const o = state.orders.get(id);
    if (!o) return;
    const was = o.status;
    o.status = status;
    if (status === 'canceled') o.canceledBy = 'printful';
    await emit(was === 'onhold' && status !== 'onhold' ? 'order_remove_hold' : (EVENT_FOR[status] ?? 'order_updated'), o);
  }
  async function ship(id: number): Promise<number> {
    const o = state.orders.get(id)!;
    let sh = o.shipments.find((x) => x.status === 'pending');
    if (!sh) {
      sh = { id: nextShipmentId++, status: 'pending', delivery: 'unknown' };
      o.shipments.push(sh);
    }
    Object.assign(sh, { status: 'shipped', delivery: 'in_transit', shippedAt: clock.now() });
    o.status = 'fulfilled';
    await emit('shipment_sent', o, sh);
    return sh.id;
  }
  async function deliver(shipmentId: number) {
    for (const o of state.orders.values()) {
      const sh = o.shipments.find((x) => x.id === shipmentId);
      if (sh) {
        sh.delivery = 'delivered';
        sh.deliveredAt = clock.now();
        await emit('shipment_delivered', o, sh);
      }
    }
  }

  app.use((req, res) => fail(res, 404, 'NotFound', `mock: no route for ${req.method} ${req.path}`));

  function reset() {
    state.files.clear();
    state.nextFileId = 900000001;
    state.mockups.clear();
    state.nextMockupId = 700000001;
    state.orders.clear();
    state.nextOrderId = 150000001;
    state.scenario = {};
    state.requests.length = 0;
    state.remaining = 120;
  }

  return {
    app,
    reset,
    scenario: (s) => (state.scenario = { ...state.scenario, ...s }),
    requests: state.requests,
    files: state.files,
    orders: state.orders,
    advance,
    ship,
    deliver,
    emit,
  };
}
