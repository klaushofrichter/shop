import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { csrfToken, SESSION_COOKIE, signSession } from '../src/admin/session';
import { registerOfferJobs, readiness, type OfferRow } from '../src/catalog/offers';
import { checkOriginal, refreshSource, type WorkRow } from '../src/catalog/works';
import { loadSkus, parseSources } from '../src/catalog-config';
import { FakeClock } from '../src/clock';
import { memoryDatabases } from '../src/db';
import { DpiTooLow, planCrop, printArea, renderPrintFile } from '../src/images/printfile';
import { FileStore } from '../src/images/store';
import { JobRunner } from '../src/jobs';
import type { ContentSource, Work } from '../src/sources/types';

const SKUS = loadSkus('config/skus.json', 'test');
const sku = (id: string) => SKUS.byId.get(id)!;
const LIMITS = { maxInputPixels: 50_000_000 };
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function store() {
  const d = mkdtempSync(path.join(tmpdir(), 'shop-pf-'));
  dirs.push(d);
  return new FileStore(d);
}
async function original(w: number, h: number) {
  // Four coloured quadrants, so crops are recognisable.
  const q = (r: number, g: number, b: number) => sharp({ create: { width: w / 2, height: h / 2, channels: 3, background: { r, g, b } } }).png().toBuffer();
  return sharp({ create: { width: w, height: h, channels: 3, background: '#000' } })
    .composite([
      { input: await q(255, 0, 0), left: 0, top: 0 },
      { input: await q(0, 255, 0), left: w / 2, top: 0 },
      { input: await q(0, 0, 255), left: 0, top: h / 2 },
      { input: await q(255, 255, 0), left: w / 2, top: h / 2 },
    ])
    .withIccProfile('p3')
    .withExifMerge({ IFD0: { Copyright: 'private' } })
    .jpeg({ quality: 95 })
    .toBuffer();
}

describe('planCrop (04 §5.2)', () => {
  it('follows the work’s orientation and the anchor', () => {
    expect(printArea(sku('print-12x16'), 'landscape')).toEqual({ w: 16, h: 12 });
    expect(printArea(sku('postcard-4x6'), 'portrait')).toEqual({ w: 4.13, h: 6.14 });
    // 4000×2000 landscape into 16×12 (4:3): crop 2667×2000, anchors move it left/right.
    const c = planCrop(sku('print-12x16'), 4000, 2000, 'c');
    expect(c).toMatchObject({ width: 2667, height: 2000, top: 0, outW: 4800, outH: 3600, effectiveDpi: 166 });
    expect(planCrop(sku('print-12x16'), 4000, 2000, 'w').left).toBe(0);
    expect(planCrop(sku('print-12x16'), 4000, 2000, 'e').left).toBe(1333);
    expect(c.cut).toBeCloseTo(1 - 2667 / 4000, 3);
    // Portrait 3024×4032 is exactly 3:4: nothing cut, 252 DPI (the design's top figure).
    expect(planCrop(sku('print-12x16'), 3024, 4032, 'n')).toMatchObject({ cut: 0, effectiveDpi: 252 });
  });

  it('mugs crop for half the wrap; t-shirts fit without cutting', () => {
    expect(planCrop(sku('mug-11oz'), 3000, 3000, 'c')).toMatchObject({ outW: 2700, outH: 1050, width: 3000, height: 2333 });
    expect(planCrop(sku('tshirt-white-m'), 4032, 3024, 'c')).toMatchObject({ cut: 0, outW: 1800, outH: 2400 });
  });
});

// Full-size renders (up to 3600 × 4800 px) take seconds of CPU; with every test file in parallel on a
// 4-core runner the 5 s default is too tight (PR #24, CI). The work, not a hang, sets this limit.
describe('renderPrintFile', { timeout: 30_000 }, () => {
  it('renders the exact size, sRGB, no metadata but the profile; the anchor picks the part', async () => {
    const s = store();
    const file = path.join(s.dir('tmp'), 'o.jpg');
    await sharp(await original(2400, 1800)).toFile(file);
    const r = await renderPrintFile(file, sku('print-6x8'), 'c', { ...LIMITS, minDpiPaper: 180, store: s });
    expect(r).toMatchObject({ ext: 'jpg', widthPx: 2400, heightPx: 1800, effectiveDpi: 300 });
    const out = s.pathOf('files', `${r.sha256}.jpg`);
    const m = await sharp(out).metadata();
    expect(m).toMatchObject({ width: 2400, height: 1800, space: 'srgb', chromaSubsampling: '4:4:4' });
    expect(m.exif).toBeUndefined();
    expect(m.icc).toBeDefined();
    // Same input, same bytes: the hash is stable.
    expect((await renderPrintFile(file, sku('print-6x8'), 'c', { ...LIMITS, minDpiPaper: 180, store: s })).sha256).toBe(r.sha256);
  });

  it('refuses a crop below the DPI floor', async () => {
    const s = store();
    const file = path.join(s.dir('tmp'), 'o.jpg');
    await sharp(await original(1200, 900)).toFile(file);
    await expect(renderPrintFile(file, sku('print-12x16'), 'c', { ...LIMITS, minDpiPaper: 180, store: s })).rejects.toThrow(DpiTooLow);
  });

  it('a mug shows the work twice; a t-shirt is a transparent PNG', async () => {
    const s = store();
    const file = path.join(s.dir('tmp'), 'o.jpg');
    await sharp(await original(3000, 2400)).toFile(file);
    const mug = await renderPrintFile(file, sku('mug-11oz'), 'c', { ...LIMITS, minDpiPaper: 180, store: s });
    const px = await sharp(s.pathOf('files', `${mug.sha256}.jpg`)).raw().toBuffer({ resolveWithObject: true });
    const at = (x: number, y: number) => [...px.data.slice((y * px.info.width + x) * 3, (y * px.info.width + x) * 3 + 3)];
    // Top-left of each half is the red quadrant.
    expect(at(5, 5)[0]).toBeGreaterThan(200);
    expect(at(px.info.width / 2 + 5, 5)[0]).toBeGreaterThan(200);
    const tee = await renderPrintFile(file, sku('tshirt-white-m'), 'c', { ...LIMITS, minDpiPaper: 180, store: s });
    expect(tee.ext).toBe('png');
    const tm = await sharp(s.pathOf('files', `${tee.sha256}.png`)).metadata();
    expect(tm).toMatchObject({ width: 1800, height: 2400, channels: 4, hasAlpha: true });
  });
});

describe('offers through the admin and the render job', { timeout: 30_000 }, () => {
  const SECRET = 'x'.repeat(40);
  const ADMIN = 'admin@example.com';
  const ART = parseSources({ sources: [{ id: 'art', default: true, adapter: 'x', publicUrl: 'https://art.example.com', printsAllowedDefault: false, printsAllowedWorks: ['w1'] }] })[0];

  async function setup(w = 3024, h = 4032) {
    const clock = new FakeClock();
    const { catalog, orders } = memoryDatabases();
    const s = store();
    const image = await original(w, h);
    let fetches = 0;
    const work: Work = { sourceId: 'art', workId: 'w1', title: 'One', kind: 'photograph', canonicalUrl: 'https://art.example.com/?id=w1', original: { url: 'https://art.example.com/a/1.jpg?v=1', version: '1' } };
    const source: ContentSource = {
      id: 'art',
      listWorks: async () => ({ works: [work], problems: [] }),
      fetchOriginal: async () => (fetches++, { body: Readable.from([image]), contentType: 'image/jpeg' }),
    };
    await refreshSource(catalog, clock, ART, source);
    catalog.exec("UPDATE works SET enabled = 1 WHERE work_id = 'w1'");
    await checkOriginal(catalog, source, s, LIMITS, 'art', 'w1');
    const runner = new JobRunner(orders, clock, () => {});
    registerOfferJobs(runner, { catalog, orders, clock, sources: new Map([['art', source]]), skus: SKUS, store: s, limits: LIMITS, registerFiles: true, log: () => {} });
    const app = createApp({
      dataDir: s.dataDir,
      admin: { catalog, orders, clock, mode: 'test', cookieSecret: SECRET, allowedEmails: [ADMIN], publicUrl: 'https://shop.example.com', skus: SKUS, storeLabel: 'test' },
    });
    const session = { email: ADMIN, exp: clock.now() + 3600_000 };
    const post = (skuId: string, form: Record<string, string>) =>
      request(app)
        .post(`/admin/works/art/w1/offers/${skuId}`)
        .set('Cookie', `${SESSION_COOKIE}=${signSession(SECRET, session)}`)
        .type('form')
        .send({ _csrf: csrfToken(SECRET, session), ...form });
    const offer = (skuId: string) => catalog.prepare("SELECT * FROM offers WHERE work_id = 'w1' AND sku_id = ?").get(skuId) as unknown as OfferRow;
    const row = () => catalog.prepare("SELECT * FROM works WHERE work_id = 'w1'").get() as unknown as WorkRow;
    return { app, catalog, orders, runner, post, offer, row, fetches: () => fetches, s, session };
  }

  it('enable → render → register; readiness says what is missing; same crop is not rendered twice', async () => {
    const t = await setup();
    const res = await t.post('print-12x16', { enabled: 'on', price: '49.00', anchor: 'n' });
    expect(res.status).toBe(303);
    expect(t.offer('print-12x16')).toMatchObject({ enabled: 1, price_cents: 4900, crop_json: '{"anchor":"n"}' });
    const before = t.fetches();
    await t.runner.tick();
    const o = t.offer('print-12x16');
    expect(o).toMatchObject({ orientation: 'portrait', effective_dpi: 252, cut_pct: 0, render_error: null });
    expect(o.print_file_sha).toMatch(/^[0-9a-f]{64}$/);
    // The checked original is kept: the render doesn't download it again.
    expect(t.fetches()).toBe(before);
    // Without the kept copy, one download; then kept again.
    const kept = t.s.pathOf('originals', t.row().original_sha256!);
    expect(existsSync(kept)).toBe(true);
    expect(t.orders.prepare("SELECT kind, key FROM jobs WHERE kind = 'printfile.register'").all()).toEqual([{ kind: 'printfile.register', key: o.print_file_sha }]);
    const pf = t.catalog.prepare('SELECT path, preview_path, width_px, height_px FROM print_files').get() as Record<string, unknown>;
    expect(pf).toMatchObject({ path: `/files/${o.print_file_sha}.jpg`, width_px: 3600, height_px: 4800 });

    expect(readiness(t.catalog, 'test', t.row(), SKUS.byId.get('print-12x16')!, o).missing).toEqual([
      'Printful file not registered yet',
      'product not checked at Printful yet',
    ]);
    t.catalog.prepare(`INSERT INTO provider_files (print_file_sha, provider, store, status, checked_at) VALUES (?, 'printful', 'test', 'ok', 'now')`).run(o.print_file_sha);
    t.catalog.exec(`INSERT INTO sku_checks (sku_id, ok, wholesale_cents, checked_at) VALUES ('print-12x16', 1, 1150, 'now')`);
    expect(readiness(t.catalog, 'test', t.row(), SKUS.byId.get('print-12x16')!, o)).toEqual({ sellable: true, missing: [] });

    // Saving the price only: no new render.
    await t.post('print-12x16', { enabled: 'on', price: '45.00', anchor: 'n' });
    expect(t.orders.prepare("SELECT COUNT(*) n FROM jobs WHERE kind = 'offer.render'").get()).toEqual({ n: 1 });
    expect(t.offer('print-12x16').price_cents).toBeNull(); // 45.00 is the default
    // The admin page shows the preview and the state.
    const page = await request(t.app).get('/admin/works/art/w1').set('Cookie', `${SESSION_COOKIE}=${signSession(SECRET, t.session)}`);
    expect(page.text).toContain(pf.preview_path as string);
    expect(page.text).toContain('Sellable');
    expect((await request(t.app).get(pf.preview_path as string)).status).toBe(200);

    // Without the kept copy, the next render downloads it once and keeps it again.
    const fetched = t.fetches();
    rmSync(kept);
    await t.post('print-8x10', { enabled: 'on', anchor: 'c' });
    await t.runner.tick();
    expect(t.fetches()).toBe(fetched + 1);
    expect(existsSync(kept)).toBe(true);
  });

  it('refuses a crop below the floor, a bad price, and a work whose source does not allow prints', async () => {
    const t = await setup(1500, 2000);
    const low = await t.post('print-12x16', { enabled: 'on', anchor: 'c' });
    expect(low.status).toBe(409);
    expect(low.text).toMatch(/125 DPI, below the floor of 180/);
    expect((await t.post('print-6x8', { enabled: 'on', price: 'ten' })).status).toBe(400);
    expect((await t.post('print-6x8', { enabled: 'on', price: '0' })).status).toBe(400);
    t.catalog.exec("UPDATE works SET prints_allowed = 0 WHERE work_id = 'w1'");
    expect((await t.post('print-6x8', { enabled: 'on' })).status).toBe(409);
    // Saving disabled is always possible.
    expect((await t.post('print-6x8', {})).status).toBe(303);
  });
});
