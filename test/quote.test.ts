import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMockPrintful, type MockPrintful } from '../mocks/printful/server';
import { createApp } from '../src/app';
import { loadSkus, parseSources } from '../src/catalog-config';
import { FakeClock } from '../src/clock';
import { loadConfig, type QuoteSettings } from '../src/config';
import { getSetting, memoryDatabases } from '../src/db';
import { PrintfulClient } from '../src/providers/printful';
import { estimatedMargin, normaliseAddress, type QuoteItem } from '../src/public/quote';
import { checkZip } from '../src/public/zip';

const SKUS = loadSkus('config/skus.json', 'test');
const SOURCES = parseSources({ sources: [{ id: 'art', default: true, adapter: 'x', publicUrl: 'https://art.example.com', printsAllowedDefault: false }] });
const SETTINGS = loadConfig({}).quote;
const clock = new FakeClock(Date.UTC(2026, 10, 26, 12));
let mock: MockPrintful;
let server: Server;
let base: string;

beforeAll(async () => {
  mock = createMockPrintful({ clock });
  server = mock.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());
beforeEach(() => mock.reset());

describe('ZIP ↔ state (05 §2, review C F16)', () => {
  it('matches the state, accepts cross-state ZIPs and unknown prefixes', () => {
    expect(checkZip('TX', '78701')).toBe('ok');
    expect(checkZip('TX', '73301')).toBe('ok'); // Austin's 733 in the middle of Oklahoma's range
    expect(checkZip('NY', '10001')).toBe('ok');
    expect(checkZip('TX', '10001')).toBe('mismatch');
    expect(checkZip('TN', '42223')).toBe('ok');
    expect(checkZip('KY', '42223')).toBe('ok');
    expect(checkZip('NY', '00199')).toBe('unknown');
  });
});

describe('address rules (03 §4)', () => {
  const good = { name: ' Jane   Doe ', email: 'Jane@Example.com', line1: '1 Main St', city: 'Austin', state: 'tx', zip: '787011234' };
  it('normalises', () => {
    expect(normaliseAddress(good).address).toEqual({ name: 'Jane Doe', email: 'jane@example.com', line1: '1 Main St', line2: undefined, city: 'Austin', state: 'TX', zip: '78701-1234' });
  });
  it('explains each problem', () => {
    const { errors } = normaliseAddress({ ...good, name: '', email: 'x', zip: '1234', state: 'PR', line1: 'Улица 1' });
    expect(Object.keys(errors).sort()).toEqual(['email', 'line1', 'name', 'state', 'zip']);
    expect(errors.line1).toMatch(/Latin/);
    expect(normaliseAddress({ ...good, zip: '10001' }).errors.zip).toMatch(/isn't in TX/);
  });
});

describe('cost check (05 §2, ADR-0036)', () => {
  const items: QuoteItem[] = [{ sourceId: 'art', workId: 'w', title: 'T', skuId: 'print-8x10', name: 'n', variantId: 4463, unitCents: 3200, quantity: 2 }];
  it('counts wholesale, shipping, tax on wholesale and the Stripe fee; never customer tax', () => {
    const s: QuoteSettings = { ...SETTINGS, providerTaxAllowancePct: 10, stripeFeePct: 3, stripeFeeFixedCents: 30 };
    const m = estimatedMargin(items, 650, 650, new Map([['print-8x10', 825]]), s)!;
    // cost (2 × 825 + 650) × 1.10 = 2530; revenue 6400 + 650 = 7050; fee 212 + 30.
    expect(m).toEqual({ estCostCents: 2530, marginCents: 7050 - 242 - 2530 });
  });
  it('an unknown wholesale price makes the order unquotable', () => {
    expect(estimatedMargin(items, 650, 650, new Map(), SETTINGS)).toBeUndefined();
  });
});

describe('address → quote (03 §4–5)', () => {
  function setup(settings: QuoteSettings = SETTINGS) {
    const { catalog, orders } = memoryDatabases();
    const logs: Record<string, unknown>[] = [];
    const app = createApp({
      publicSite: {
        catalog, orders, clock, mode: 'test', skus: SKUS, sources: SOURCES, limits: loadConfig({}).limits, storeLabel: 'test',
        secret: 'x'.repeat(40), previewGate: false, allowedEmails: [],
        statusSecret: 'st'.repeat(20),
      quote: { settings, provider: new PrintfulClient({ baseUrl: base, token: 'mock_printful_1', timeoutMs: 2000 }), providerReady: () => true, log: (l) => logs.push(l) },
      },
    });
    catalog.exec(`INSERT INTO works (source_id, work_id, title, canonical_url, original_url, prints_allowed, enabled, seen_at) VALUES ('art', 'w1', 'Undertow', 'u', 'u', 1, 1, 'now')`);
    for (const [sku, wholesale] of [['print-8x10', 825], ['mug-11oz', 695]] as const) {
      const sha = sku.padEnd(64, '0');
      catalog.prepare(`INSERT INTO print_files (sha256, render_key, path, width_px, height_px, bytes, created_at) VALUES (?, ?, '/files/x.jpg', 1, 1, 1, 'now')`).run(sha, sha);
      catalog.prepare(`INSERT INTO offers (source_id, work_id, sku_id, enabled, print_file_sha, orientation) VALUES ('art', 'w1', ?, 1, ?, 'landscape')`).run(sku, sha);
      catalog.prepare(`INSERT INTO provider_files (print_file_sha, provider, store, status, checked_at) VALUES (?, 'printful', 'test', 'ok', 'now')`).run(sha);
      catalog.prepare(`INSERT INTO sku_checks (sku_id, ok, wholesale_cents, checked_at) VALUES (?, 1, ?, 'now')`).run(sku, wholesale);
    }
    // A visitor with its own cookies (the shop's are Secure; see public.test.ts).
    const jar = new Map<string, string>();
    const keep = (res: request.Response) => {
      for (const c of ([] as string[]).concat(res.headers['set-cookie'] ?? [])) {
        const [pair] = c.split(';');
        const i = pair.indexOf('=');
        jar.set(pair.slice(0, i), pair.slice(i + 1));
      }
      return res;
    };
    const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const get = async (path: string) => keep(await request(app).get(path).set('Cookie', cookie()));
    const post = async (path: string, body: object) => keep(await request(app).post(path).set('Cookie', cookie()).type('form').send(body));
    const token = async (path = '/cart') => /name="_csrf" value="([^"]+)"/.exec((await get(path)).text)![1];
    return { catalog, orders, logs, get, post, token };
  }
  const ADDRESS = { name: 'Jane Doe', email: 'jane@example.com', line1: '1 Main St', city: 'Austin', state: 'TX', zip: '78701' };

  async function withCart(t: ReturnType<typeof setup>) {
    const tok = await t.token('/p/art/w1');
    await t.post('/cart/items', { _csrf: tok, source: 'art', work: 'w1', sku: 'print-8x10', quantity: 2 });
    return tok;
  }

  it('quotes in one Printful call without the name; the quote page offers the shipping methods and Pay', async () => {
    const t = setup();
    const tok = await withCart(t);
    const res = await t.post('/cart/address', { _csrf: tok, ...ADDRESS });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/quote');
    const calls = mock.requests.filter((r) => r.path === '/v2/shipping-rates');
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls[0].body)).not.toMatch(/Jane|jane@/);
    const q = await t.get('/quote');
    expect(q.text).toContain('Art print 8 × 10 in, landscape');
    expect(q.text).toContain('2 × $32.00');
    expect(q.text).toMatch(/name="shipping" value="STANDARD" checked/);
    expect(q.text).toContain('STANDARD_CARBON_OFFSET');
    expect(q.text).toContain('Pay with Stripe');
    expect(q.text).toContain('Ship to Jane Doe, 1 Main St, Austin, TX 78701, US');
    // The e-mail and address live on the quote, not on the cart (review C F14).
    expect(t.orders.prepare('SELECT email FROM quotes').get()).toEqual({ email: 'jane@example.com' });
    // The cart page now prefills the form from the quote.
    expect((await t.get('/cart')).text).toContain('value="1 Main St"');
    // Payment arrives with step 6.
    expect((await t.post('/checkout', { _csrf: tok })).status).toBe(503);
  });

  it('re-renders the form with every problem; a ZIP of another state is counted', async () => {
    const t = setup();
    const tok = await withCart(t);
    const res = await t.post('/cart/address', { _csrf: tok, ...ADDRESS, zip: '10001', email: 'nope' });
    expect(res.status).toBe(422);
    expect(res.text).toContain('role="alert"');
    expect(res.text).toContain('Please check 2 fields');
    expect(res.text).toContain('aria-invalid="true"');
    expect(getSetting(t.orders, 'zip_rejections')).toBe(1);
    expect(mock.requests.filter((r) => r.path === '/v2/shipping-rates')).toHaveLength(0);
  });

  it('a cost check that fails replaces Pay and alerts Klaus', async () => {
    const t = setup({ ...SETTINGS, marginFloorCents: 100_000 });
    const tok = await withCart(t);
    await t.post('/cart/address', { _csrf: tok, ...ADDRESS });
    const q = await t.get('/quote');
    expect(q.text).toContain("This combination can't be ordered right now");
    expect(q.text).not.toContain('Pay with Stripe');
    expect(t.logs.some((l) => l.level === 'alert' && l.msg === 'cost check failed at quote')).toBe(true);
  });

  it('Printful down: a clear message and no quote', async () => {
    const t = setup();
    const tok = await withCart(t);
    mock.scenario({ status: { code: 503, count: 1 } });
    const res = await t.post('/cart/address', { _csrf: tok, ...ADDRESS });
    expect(res.status).toBe(503);
    expect(res.text).toContain('We can&#39;t calculate shipping right now');
    expect(t.orders.prepare('SELECT COUNT(*) n FROM quotes').get()).toEqual({ n: 0 });
  });

  it('expires after 30 minutes and offers a re-quote; a changed cart drops the quote', async () => {
    const t = setup();
    const tok = await withCart(t);
    await t.post('/cart/address', { _csrf: tok, ...ADDRESS });
    clock.advance(31 * 60_000);
    const q = await t.get('/quote');
    expect(q.text).toContain('This quote has expired');
    expect(q.text).toContain('Update the quote');
    expect(q.text).not.toContain('Pay with Stripe');
    await t.post('/cart/items', { _csrf: tok, source: 'art', work: 'w1', sku: 'mug-11oz', quantity: 1 });
    const after = await t.get('/quote');
    expect(after.status).toBe(303);
    expect(after.headers.location).toBe('/cart');
  });
});
