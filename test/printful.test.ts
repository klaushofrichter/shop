import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMockPrintful, MOCK_STORE, type MockPrintful } from '../mocks/printful/server';
import { createApp } from '../src/app';
import { loadSkus } from '../src/catalog-config';
import { FakeClock } from '../src/clock';
import { memoryDatabases } from '../src/db';
import { FileStore } from '../src/images/store';
import { enqueue, JobRunner, type JobRow } from '../src/jobs';
import { formatCents, parseCents } from '../src/money';
import { compareSku, StartupRefused, verifyIdentity } from '../src/providers/checks';
import { ProviderStatus, registerProviderJobs, scheduleProviderJobs } from '../src/providers/jobs';
import { PrintfulClient } from '../src/providers/printful';
import { ProviderError } from '../src/providers/types';

const clock = new FakeClock(Date.UTC(2026, 10, 26, 15));
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

const client = (token = 'mock_printful_1') => new PrintfulClient({ baseUrl: base, token, timeoutMs: 2000 });
const AUSTIN = { address1: '1 Main St', city: 'Austin', stateCode: 'TX', zip: '78701', countryCode: 'US', name: 'Jane Doe' };

describe('money', () => {
  it('converts decimal strings exactly', () => {
    expect(parseCents('10.89')).toBe(1089);
    expect(parseCents('0.1')).toBe(10);
    expect(parseCents('45')).toBe(4500);
    expect(parseCents('-1.05')).toBe(-105);
    expect(() => parseCents('1.005')).toThrow();
    expect(() => parseCents('1e3')).toThrow();
    expect(formatCents(1089)).toBe('10.89');
    expect(formatCents(5)).toBe('0.05');
  });
});

describe('identity (06 §3)', () => {
  it('verifies the expected store and the scopes', async () => {
    expect(await verifyIdentity(client(), String(MOCK_STORE.id))).toEqual({ state: 'verified', storeId: String(MOCK_STORE.id) });
    expect(await verifyIdentity(client(), undefined)).toMatchObject({ state: 'verified' });
  });

  it('refuses the start on a wrong answer: another store, a refused token', async () => {
    await expect(verifyIdentity(client(), '42')).rejects.toThrow(StartupRefused);
    await expect(verifyIdentity(client('not-a-mock-token'), undefined)).rejects.toThrow(/refused the token/);
  });

  it('starts unverified when Printful does not answer', async () => {
    mock.scenario({ status: { code: 503, count: 5 } });
    expect(await verifyIdentity(client(), undefined)).toMatchObject({ state: 'unverified' });
    const nowhere = new PrintfulClient({ baseUrl: 'http://127.0.0.1:9', token: 'mock_printful_1', timeoutMs: 500 });
    expect(await verifyIdentity(nowhere, undefined)).toMatchObject({ state: 'unverified' });
  });
});

describe('catalog', () => {
  it('describes a variant: product, print area per orientation, price, stock', async () => {
    const v = await client().describeVariant(4463);
    expect(v).toMatchObject({ variantId: 4463, productId: 1, technique: 'digital', available: true, wholesaleCents: 825 });
    expect(v.placements.map((p) => p.orientation).sort()).toEqual(['horizontal', 'vertical']);
  });

  it('every launch SKU matches the catalog', async () => {
    const skus = loadSkus('config/skus.json', 'mock');
    for (const sku of skus.skus) {
      const r = compareSku(sku, await client().describeVariant(sku.variants.any!));
      expect(r, sku.id).toMatchObject({ ok: true });
    }
  });

  it('reports a mismatch and an unknown variant', async () => {
    const sku = { ...loadSkus('config/skus.json', 'mock').byId.get('print-8x10')!, printAreaIn: [9, 12] as [number, number], productId: 2 };
    const r = compareSku(sku, await client().describeVariant(4463));
    expect(r.ok).toBe(false);
    expect(r.problem).toMatch(/product 1, configured 2.*print area 9 × 12/);
    await expect(client().describeVariant(999999999)).rejects.toMatchObject({ kind: 'permanent', message: 'printful: Not Found' });
  });
});

describe('shipping rates', () => {
  it('quotes one call, both methods, parcels for mixed carts; sends no name, e-mail or phone (ADR-0031)', async () => {
    const one = await client().shippingRates(AUSTIN, [{ variantId: 4651, quantity: 1 }]);
    expect(one.map((r) => r.id)).toEqual(['STANDARD', 'STANDARD_CARBON_OFFSET']);
    expect(one[0]).toMatchObject({ parcels: 1, minDays: 4, maxDays: 6 });
    expect(Number.isInteger(one[0].cents)).toBe(true);
    const mixed = await client().shippingRates(AUSTIN, [{ variantId: 4651, quantity: 1 }, { variantId: 4012, quantity: 1 }]);
    expect(mixed[0].parcels).toBe(2);
    const sent = mock.requests.filter((r) => r.path === '/v2/shipping-rates').map((r) => r.body as { recipient: Record<string, unknown> });
    for (const b of sent) expect(Object.keys(b.recipient).sort()).toEqual(['address1', 'city', 'country_code', 'state_code', 'zip']);
  });

  it('maps the captured errors', async () => {
    await expect(client().shippingRates({ ...AUSTIN, stateCode: 'XX' }, [{ variantId: 4463, quantity: 1 }])).rejects.toMatchObject({
      kind: 'permanent',
      status: 400,
      message: 'printful: Invalid state `XX` select a valid state for country `US`',
    });
    await expect(client().shippingRates(AUSTIN, [{ variantId: 999999999, quantity: 1 }])).rejects.toMatchObject({
      kind: 'permanent',
      status: 404,
      message: 'printful: Variant with ID: 999999999 does not exist.',
    });
  });
});

describe('the mock checks requests against the pinned spec (14 §7.1)', () => {
  const post = (body: unknown) =>
    fetch(`${base}/v2/shipping-rates`, { method: 'POST', headers: { authorization: 'Bearer mock_printful_1', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const good = { recipient: { country_code: 'US', state_code: 'TX', zip: '78701' }, order_items: [{ source: 'catalog', catalog_variant_id: 4463, quantity: 1 }] };

  it('answers a string id like Printful does', async () => {
    const res = await post({ ...good, order_items: [{ source: 'catalog', catalog_variant_id: '4463', quantity: 1 }] });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toBe('Property `/order_items/0/catalog_variant_id` must be of type `int`, `string` provided');
  });

  it('refuses unknown fields, which Printful would silently ignore', async () => {
    const res = await post({ ...good, recipient: { ...good.recipient, stat_code: 'TX' } });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/unevaluated properties: stat_code/);
  });
});

describe('errors and rate limits', () => {
  it('reads the rate-limit headers', async () => {
    const c = client();
    await c.describeVariant(4463);
    expect(c.rateLimit.remaining).toBeLessThan(120);
    expect(c.rateLimit.resetMs).toBe(500);
  });

  it('429 is rate_limited with Retry-After; 5xx on a read is unavailable', async () => {
    mock.scenario({ status: { code: 429, count: 1, retryAfterS: 7 } });
    await expect(client().describeVariant(4463)).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 7000 });
    mock.scenario({ status: { code: 502, count: 1 } });
    await expect(client().describeVariant(4463)).rejects.toMatchObject({ kind: 'unavailable', status: 502 });
  });
});

describe('file library (04 §5.3)', () => {
  it('registers invisibly as a print file, de-duplicates by URL, waiting then ok', async () => {
    const url = 'https://shop.example.com/files/abc.jpg';
    const f1 = await client().registerFile(url);
    expect(f1.status).toBe('waiting');
    expect(mock.requests.at(-1)!.body).toEqual({ role: 'printfile', url, visible: false });
    expect((await client().registerFile(url)).id).toBe(f1.id);
    clock.advance(5000);
    expect(await client().getFile(f1.id)).toMatchObject({ status: 'ok', width: 3600, height: 4800 });
  });

  it('a file Printful cannot read ends failed', async () => {
    mock.scenario({ failFilesMatching: 'broken' });
    const f = await client().registerFile('https://shop.example.com/files/broken.jpg');
    clock.advance(5000);
    expect((await client().getFile(f.id)).status).toBe('failed');
  });
});

describe('provider jobs', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function setup(initial: 'verified' | 'unverified' = 'verified') {
    const { catalog, orders } = memoryDatabases();
    const runner = new JobRunner(orders, clock, () => {});
    const status = new ProviderStatus(clock, initial === 'verified' ? { state: 'verified', storeId: '1' } : { state: 'unverified', reason: 'x' });
    const logs: Record<string, unknown>[] = [];
    registerProviderJobs(runner, {
      provider: client(), status, expectedStore: undefined, storeLabel: 'mock', publicUrl: 'https://shop.example.com',
      catalog, orders, clock, skus: loadSkus('config/skus.json', 'mock'), log: (l) => logs.push(l),
    });
    const job = (kind: string) => orders.prepare('SELECT * FROM jobs WHERE kind = ? ORDER BY id DESC').get(kind) as unknown as JobRow;
    return { catalog, orders, runner, status, logs, job };
  }

  it('the catalog check stores every SKU and keeps the last answer when Printful is down', async () => {
    const { catalog, orders, runner } = setup();
    scheduleProviderJobs(orders, clock, new ProviderStatus(clock, { state: 'verified', storeId: '1' }));
    await runner.tick();
    const rows = catalog.prepare('SELECT * FROM sku_checks ORDER BY sku_id').all() as Array<{ sku_id: string; ok: number; wholesale_cents: number }>;
    expect(rows).toHaveLength(11);
    expect(rows.every((r) => r.ok === 1)).toBe(true);
    expect(rows.find((r) => r.sku_id === 'print-8x10')!.wholesale_cents).toBe(825);

    mock.scenario({ status: { code: 503, count: 1000 } });
    enqueue(orders, clock, 'catalog.check', 'now');
    await runner.tick();
    expect((catalog.prepare('SELECT COUNT(*) n FROM sku_checks WHERE ok = 1').get() as { n: number }).n).toBe(11);
  });

  it('jobs wait while unverified; printful.verify retries and then starts the catalog check', async () => {
    const { orders, runner, status, job } = setup('unverified');
    mock.scenario({ status: { code: 503, count: 1 } }); // the first identity call goes unanswered
    scheduleProviderJobs(orders, clock, status);
    await runner.tick();
    expect(job('printful.verify')).toMatchObject({ state: 'queued', attempts: 0 });
    clock.advance(60_000);
    await runner.tick();
    expect(status.verified).toBe(true);
    // It ran, and queued its next daily run.
    expect((orders.prepare("SELECT state FROM jobs WHERE kind = 'catalog.check' ORDER BY id").all() as Array<{ state: string }>).map((r) => r.state)).toEqual(['done', 'queued']);
  });

  it('printfile.register registers by public URL and polls until ok', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'shop-pf-'));
    dirs.push(dir);
    const { catalog, orders, runner } = setup();
    const sha = new FileStore(dir).put('files', 'jpg', Buffer.from('print'));
    catalog.prepare(`INSERT INTO print_files (sha256, render_key, path, width_px, height_px, bytes, created_at) VALUES (?, 'k', ?, 1, 1, 5, 'now')`).run(sha, `/files/${sha}.jpg`);
    enqueue(orders, clock, 'printfile.register', sha, { sha });
    await runner.tick();
    const pf = () => catalog.prepare('SELECT status, provider_file_id FROM provider_files').get() as { status: string; provider_file_id: string };
    expect(pf().status).toBe('waiting');
    expect(mock.requests.find((r) => r.path === '/v2/files')!.body).toMatchObject({ url: `https://shop.example.com/files/${sha}.jpg` });
    clock.advance(5000);
    await runner.tick();
    expect(pf().status).toBe('ok');
    expect(mock.requests.filter((r) => r.path === '/v2/files')).toHaveLength(1);

    // /files serves it, immutable.
    const res = await request(createApp({ dataDir: dir })).get(`/files/${sha}.jpg`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });
});
