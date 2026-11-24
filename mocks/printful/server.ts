/**
 * Mock Printful, stage 1 (docs/design/14 §4, §10): identity, catalog, shipping
 * rates, the file library, rate-limit headers, the control API skeleton.
 * Orders, mockups and webhooks follow with the shop's steps 4 and 7.
 *
 * Shapes follow the 2026-11-24 captures; requests are validated against the
 * pinned v2 spec and unknown fields are refused (14 §7.1). Mock tokens start
 * with `mock_printful_`; anything else gets Printful's 401.
 */
import express, { type Express, type Request, type Response } from 'express';
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
}

let spec: PrintfulSpec | undefined;

export function createMockPrintful(opts: { clock: Clock & { advance?(ms: number): void } }): MockPrintful {
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

  app.use((req, res) => fail(res, 404, 'NotFound', `mock: no route for ${req.method} ${req.path}`));

  function reset() {
    state.files.clear();
    state.nextFileId = 900000001;
    state.mockups.clear();
    state.nextMockupId = 700000001;
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
  };
}
