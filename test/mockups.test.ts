import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMockPrintful, type MockPrintful } from '../mocks/printful/server';
import { createApp } from '../src/app';
import { loadSkus } from '../src/catalog-config';
import { FakeClock } from '../src/clock';
import { memoryDatabases } from '../src/db';
import { FileStore } from '../src/images/store';
import { enqueue, JobRunner, type JobRow } from '../src/jobs';
import { PrintfulClient } from '../src/providers/printful';
import { ProviderStatus, registerMockupJob } from '../src/providers/jobs';

const clock = new FakeClock(Date.UTC(2026, 10, 26, 18));
const SKUS = loadSkus('config/skus.json', 'test');
let mock: MockPrintful;
let server: Server;
let base: string;
const dirs: string[] = [];

beforeAll(async () => {
  mock = createMockPrintful({ clock });
  server = mock.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());
beforeEach(() => mock.reset());
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'shop-mk-'));
  dirs.push(dir);
  const store = new FileStore(dir);
  const { catalog, orders } = memoryDatabases();
  const runner = new JobRunner(orders, clock, () => {});
  const logs: Record<string, unknown>[] = [];
  registerMockupJob(runner, {
    provider: new PrintfulClient({ baseUrl: base, token: 'mock_printful_1', timeoutMs: 2000 }),
    status: new ProviderStatus(clock, { state: 'verified', storeId: '1' }),
    expectedStore: undefined, storeLabel: 'test', publicUrl: 'https://shop.example.com',
    catalog, orders, clock, skus: SKUS, store, log: (l) => logs.push(l),
  });
  catalog.exec(`INSERT INTO works (source_id, work_id, title, canonical_url, original_url, prints_allowed, enabled, seen_at) VALUES ('art', 'w1', 'One', 'u', 'u', 1, 1, 'now')`);
  const addOffer = (sku: string, sha: string, orientation = 'landscape') => {
    catalog.prepare(`INSERT OR IGNORE INTO print_files (sha256, render_key, path, width_px, height_px, bytes, created_at) VALUES (?, ?, ?, 1, 1, 1, 'now')`).run(sha, `k-${sha}`, `/files/${sha}.jpg`);
    catalog
      .prepare(`INSERT INTO offers (source_id, work_id, sku_id, enabled, print_file_sha, orientation) VALUES ('art', 'w1', ?, 1, ?, ?)
                ON CONFLICT (source_id, work_id, sku_id) DO UPDATE SET print_file_sha = excluded.print_file_sha`)
      .run(sku, sha, orientation);
  };
  const queue = (sku: string) => enqueue(orders, clock, 'mockup.create', `art/w1/${sku}`, { sourceId: 'art', workId: 'w1', skuId: sku });
  const offer = (sku: string) => catalog.prepare("SELECT mockup_sha, mockup_task_id, mockup_for FROM offers WHERE sku_id = ?").get(sku) as Record<string, string | null>;
  const job = (key: string) => orders.prepare("SELECT * FROM jobs WHERE kind = 'mockup.create' AND key = ? ORDER BY id DESC").get(key) as unknown as JobRow;
  return { store, dir, catalog, orders, runner, logs, addOffer, queue, offer, job };
}

describe('mockups (04 §7)', () => {
  it('creates a task with the print file URL and orientation, polls, stores the image without metadata', async () => {
    const t = setup();
    const sha = 'a'.repeat(64);
    t.addOffer('print-8x10', sha);
    t.queue('print-8x10');
    await t.runner.tick();
    const sent = mock.requests.find((r) => r.path === '/v2/mockup-tasks')!.body as { products: Array<Record<string, unknown>> };
    expect(sent.products[0]).toMatchObject({
      catalog_product_id: 1, catalog_variant_ids: [4463], orientation: 'horizontal',
      placements: [{ placement: 'default', technique: 'digital', layers: [{ type: 'file', url: `https://shop.example.com/files/${sha}.jpg` }] }],
    });
    expect(t.offer('print-8x10')).toMatchObject({ mockup_sha: null, mockup_for: sha });
    clock.advance(5_000);
    await t.runner.tick(); // still pending
    expect(t.offer('print-8x10').mockup_sha).toBeNull();
    clock.advance(20_000);
    await t.runner.tick();
    const o = t.offer('print-8x10');
    expect(o.mockup_sha).toMatch(/^[0-9a-f]{64}$/);
    expect(o.mockup_task_id).toBeNull();
    const m = await sharp(t.store.pathOf('mockups', `${o.mockup_sha}.jpg`)).metadata();
    expect(m.exif).toBeUndefined();
    const res = await request(createApp({ dataDir: t.dir })).get(`/mockups/${o.mockup_sha}.jpg`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('paces tasks 30 s apart; t-shirts go to the front placement with DTG and no orientation', async () => {
    const t = setup();
    t.addOffer('print-8x10', 'b'.repeat(64));
    t.addOffer('tshirt-white-m', 'c'.repeat(64), 'portrait');
    t.queue('print-8x10');
    t.queue('tshirt-white-m');
    await t.runner.tick();
    expect(mock.requests.filter((r) => r.path === '/v2/mockup-tasks')).toHaveLength(1);
    clock.advance(30_000);
    await t.runner.tick();
    const posts = mock.requests.filter((r) => r.path === '/v2/mockup-tasks');
    expect(posts).toHaveLength(2);
    const tee = (posts[1].body as { products: Array<Record<string, unknown>> }).products[0];
    expect(tee.orientation).toBeUndefined();
    expect(tee).toMatchObject({ catalog_variant_ids: [4012], placements: [{ placement: 'front', technique: 'dtg' }] });
  });

  it('a failed task leaves no mockup (the display image stands in) and is not retried', async () => {
    const t = setup();
    mock.scenario({ failMockups: true });
    t.addOffer('mug-11oz', 'd'.repeat(64), 'portrait');
    t.queue('mug-11oz');
    await t.runner.tick();
    clock.advance(25_000);
    await t.runner.tick();
    expect(t.offer('mug-11oz')).toMatchObject({ mockup_sha: null, mockup_task_id: null });
    expect(t.job('art/w1/mug-11oz').state).toBe('failed');
    expect(t.logs.some((l) => l.msg === 'mockup failed; the display image stands in')).toBe(true);
  });

  it('a current mockup is not made again; a new print file needs a new one', async () => {
    const t = setup();
    t.addOffer('print-8x10', 'e'.repeat(64));
    t.queue('print-8x10');
    await t.runner.tick();
    clock.advance(30_000);
    await t.runner.tick();
    const first = t.offer('print-8x10').mockup_sha;
    expect(first).toBeTruthy();
    t.queue('print-8x10');
    await t.runner.tick();
    expect(mock.requests.filter((r) => r.path === '/v2/mockup-tasks')).toHaveLength(1);
    // offer.render clears a mockup that shows another print file; here the same rule by hand.
    t.addOffer('print-8x10', 'f'.repeat(64));
    t.catalog.exec("UPDATE offers SET mockup_sha = NULL WHERE sku_id = 'print-8x10'");
    t.queue('print-8x10');
    clock.advance(30_000);
    await t.runner.tick();
    expect(mock.requests.filter((r) => r.path === '/v2/mockup-tasks')).toHaveLength(2);
  });
});
