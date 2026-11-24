import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { registerCatalogJobs, scheduleSourceRefresh, SOURCES_REFRESH_EVERY_MS } from '../src/catalog/jobs';
import { checkOriginal, refreshSource, type WorkRow } from '../src/catalog/works';
import { parseSources } from '../src/catalog-config';
import { FakeClock } from '../src/clock';
import { getSetting, memoryDatabases } from '../src/db';
import { FileStore } from '../src/images/store';
import { JobRunner } from '../src/jobs';
import type { ContentSource, Work } from '../src/sources/types';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp() {
  const d = mkdtempSync(path.join(tmpdir(), 'shop-cat-'));
  dirs.push(d);
  return d;
}

const ART = parseSources({
  sources: [{ id: 'art', default: true, adapter: 'art-manifest', publicUrl: 'https://art.example.com', printsAllowedDefault: false, printsAllowedWorks: ['w1'] }],
})[0];
const LIMITS = { maxInputPixels: 50_000_000 };

function work(id: string, version = 'v1'): Work {
  return {
    sourceId: 'art', workId: id, title: `Work ${id}`, kind: 'photograph',
    canonicalUrl: `https://art.example.com/?id=${id}`,
    original: { url: `https://art.example.com/assets/r/${id}.jpg?v=${version}`, version },
  };
}

/** A Display P3 JPEG with EXIF (camera data, GPS-like tags) and orientation 6. */
async function p3Jpeg(width: number, height: number, colour = { r: 200, g: 40, b: 40 }) {
  return sharp({ create: { width, height, channels: 3, background: colour } })
    .withMetadata({ orientation: 6 })
    .withIccProfile('p3')
    .withExifMerge({ IFD0: { Copyright: 'private', Artist: 'someone' } })
    .jpeg()
    .toBuffer();
}

class FakeSource implements ContentSource {
  readonly id = 'art';
  fetches = 0;
  constructor(public works: Work[], public image: Buffer, public type = 'image/jpeg') {}
  async listWorks() {
    return { works: this.works, problems: ['room x: drift'] };
  }
  async fetchOriginal() {
    this.fetches++;
    return { body: Readable.from([this.image]), contentType: this.type, contentLength: this.image.length };
  }
}

const row = (db: ReturnType<typeof memoryDatabases>['catalog'], id: string) =>
  db.prepare('SELECT * FROM works WHERE work_id = ?').get(id) as unknown as WorkRow;

describe('refreshSource', () => {
  it('stores allow-listed works, consent from the allow-list, hides missing works', async () => {
    const { catalog } = memoryDatabases();
    const clock = new FakeClock();
    const src = new FakeSource([work('w1'), work('w2')], Buffer.alloc(0));
    const r1 = await refreshSource(catalog, clock, ART, src);
    expect(r1).toMatchObject({ listed: 2, hidden: 0, toCheck: [] });
    expect(row(catalog, 'w1')).toMatchObject({ prints_allowed: 1, enabled: 0, listed: 1, source_version: 'v1' });
    expect(row(catalog, 'w2').prints_allowed).toBe(0);

    // Klaus enables w1; a new version of w1 needs a check; w2 disappears.
    catalog.exec("UPDATE works SET enabled = 1, original_sha256 = 'x' WHERE work_id = 'w1'");
    src.works = [work('w1', 'v2')];
    const r2 = await refreshSource(catalog, clock, ART, src);
    expect(r2).toMatchObject({ listed: 1, hidden: 1, toCheck: [{ sourceId: 'art', workId: 'w1' }] });
    expect(row(catalog, 'w2').listed).toBe(0);
    expect(row(catalog, 'w1').enabled).toBe(1);

    // Back again: listed, still disabled; unchanged versions need no check.
    src.works = [work('w1', 'v2'), work('w2')];
    expect((await refreshSource(catalog, clock, ART, src)).toCheck).toEqual([]);
    expect(row(catalog, 'w2').listed).toBe(1);
  });
});

describe('checkOriginal and display images', () => {
  it('renders sRGB images without metadata, upright, never enlarged; re-renders only on a new hash', async () => {
    const { catalog } = memoryDatabases();
    const store = new FileStore(tmp());
    const src = new FakeSource([work('w1')], await p3Jpeg(1200, 800));
    await refreshSource(catalog, new FakeClock(), ART, src);

    const first = await checkOriginal(catalog, src, store, LIMITS, 'art', 'w1');
    expect(first.changed).toBe(true);
    // Orientation 6: the stored size is the upright one.
    expect(row(catalog, 'w1')).toMatchObject({ original_sha256: first.sha256, original_px_w: 800, original_px_h: 1200 });

    const images = catalog.prepare('SELECT * FROM display_images ORDER BY width_px, format').all() as Array<Record<string, unknown>>;
    // 800 px wide: 640 and 800 (capped), each as WebP and JPEG.
    expect(images.map((i) => `${i.width_px}x${i.height_px}.${i.format}`)).toEqual(['640x960.jpeg', '640x960.webp', '800x1200.jpeg', '800x1200.webp']);
    for (const im of images) {
      const file = path.join(store.dataDir, String(im.path));
      expect(existsSync(file)).toBe(true);
      const m = await sharp(file).metadata();
      expect(m.exif).toBeUndefined();
      expect(m.xmp).toBeUndefined();
      expect(m.iptc).toBeUndefined();
      expect(m.orientation ?? 1).toBe(1);
      expect(m.space).toBe('srgb');
      if (m.format === 'jpeg') expect(m.icc).toBeDefined(); // the sRGB profile only
    }

    // Same bytes again: nothing re-rendered.
    expect((await checkOriginal(catalog, src, store, LIMITS, 'art', 'w1')).changed).toBe(false);
    // New bytes: new images replace the old rows.
    src.image = await p3Jpeg(1200, 800, { r: 10, g: 200, b: 10 });
    expect((await checkOriginal(catalog, src, store, LIMITS, 'art', 'w1')).changed).toBe(true);
    expect((catalog.prepare('SELECT COUNT(*) n FROM display_images').get() as { n: number }).n).toBe(4);
  });

  it('refuses other types and decompression bombs', async () => {
    const { catalog } = memoryDatabases();
    const store = new FileStore(tmp());
    const src = new FakeSource([work('w1')], await p3Jpeg(2000, 2000), 'text/html');
    await refreshSource(catalog, new FakeClock(), ART, src);
    await expect(checkOriginal(catalog, src, store, LIMITS, 'art', 'w1')).rejects.toThrow(/type text\/html/);
    src.type = 'image/jpeg';
    await expect(checkOriginal(catalog, src, store, { maxInputPixels: 1_000_000 }, 'art', 'w1')).rejects.toThrow(/pixel limit/i);
  });
});

describe('catalog jobs', () => {
  it('refreshes every 10 minutes, records drift, and checks enabled works', async () => {
    const { catalog, orders } = memoryDatabases();
    const clock = new FakeClock();
    const src = new FakeSource([work('w1')], await p3Jpeg(700, 500));
    const runner = new JobRunner(orders, clock, () => {});
    registerCatalogJobs(runner, {
      catalog, orders, clock, sources: new Map([['art', src]]), sourceConfigs: [ART],
      store: new FileStore(tmp()), limits: LIMITS, log: () => {},
    });
    scheduleSourceRefresh(orders, clock, ['art']);
    expect(await runner.tick()).toBe(1);
    expect(getSetting(orders, 'source_problems:art')).toEqual(['room x: drift']);
    expect(src.fetches).toBe(0); // nothing enabled yet

    catalog.exec("UPDATE works SET enabled = 1 WHERE work_id = 'w1'");
    clock.advance(SOURCES_REFRESH_EVERY_MS);
    expect(await runner.tick()).toBe(2); // the refresh, then the original check it queued
    expect(src.fetches).toBe(1);
    expect(row(catalog, 'w1').original_sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('/img', () => {
  it('serves display images by hash, immutable, and nothing else', async () => {
    const dir = tmp();
    const store = new FileStore(dir);
    const sha = store.put('img', 'webp', await sharp({ create: { width: 4, height: 4, channels: 3, background: '#fff' } }).webp().toBuffer());
    const app = createApp({ dataDir: dir });
    const ok = await request(app).get(`/img/${sha}.webp`);
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toBe('image/webp');
    expect(ok.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect((await request(app).get(`/img/${'0'.repeat(64)}.webp`)).status).toBe(404);
    expect((await request(app).get('/img/..%2F..%2Fetc%2Fpasswd')).status).toBe(404);
    expect((await request(app).get(`/img/${sha}.png`)).status).toBe(404);
    expect(ok.headers['ratelimit-policy']).toMatch(/600/);
  });
});
