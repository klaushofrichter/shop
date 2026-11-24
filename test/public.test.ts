import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { SESSION_COOKIE, signSession } from '../src/admin/session';
import { loadSkus, parseSources } from '../src/catalog-config';
import { FakeClock } from '../src/clock';
import { loadConfig, type Mode } from '../src/config';
import { memoryDatabases } from '../src/db';

const SKUS = loadSkus('config/skus.json', 'test');
const SOURCES = parseSources({ sources: [{ id: 'art', default: true, adapter: 'x', publicUrl: 'https://art.example.com', printsAllowedDefault: false }] });
const SECRET = 's'.repeat(40);
const LIMITS = { ...loadConfig({}).limits, maxItemsPerOrder: 5, maxQuantity: { default: 3, 'postcard-4x6': 4 } };

function setup(opts: { mode?: Mode; gate?: boolean; key?: string } = {}) {
  const clock = new FakeClock();
  const { catalog, orders } = memoryDatabases();
  const app = createApp({
    publicSite: {
      catalog, orders, clock, mode: opts.mode ?? 'test', skus: SKUS, sources: SOURCES, limits: LIMITS, storeLabel: 'test',
      secret: SECRET, previewGate: opts.gate ?? false, previewKey: opts.key, adminSecret: SECRET, allowedEmails: ['admin@example.com'],
    },
  });
  const work = (id: string, sellable: string[], enabled = 1) => {
    catalog
      .prepare(`INSERT INTO works (source_id, work_id, title, creator, year, kind, canonical_url, original_url, prints_allowed, enabled, seen_at)
                VALUES ('art', ?, ?, 'A. Painter', '2024', 'painting', ?, 'u', 1, ?, 'now')`)
      .run(id, `Work ${id}`, `https://art.example.com/?id=${id}`, enabled);
    for (const skuId of sellable) {
      const sha = `${id}-${skuId}`.padEnd(64, '0');
      catalog.prepare(`INSERT INTO print_files (sha256, render_key, path, width_px, height_px, bytes, created_at) VALUES (?, ?, '/files/x.jpg', 1, 1, 1, 'now')`).run(sha, sha);
      catalog.prepare(`INSERT INTO offers (source_id, work_id, sku_id, enabled, print_file_sha, orientation) VALUES ('art', ?, ?, 1, ?, 'landscape')`).run(id, skuId, sha);
      catalog.prepare(`INSERT INTO provider_files (print_file_sha, provider, store, status, checked_at) VALUES (?, 'printful', 'test', 'ok', 'now')`).run(sha);
      catalog.prepare(`INSERT OR IGNORE INTO sku_checks (sku_id, ok, checked_at) VALUES (?, 1, 'now')`).run(skuId);
    }
  };
  /**
   * A visitor that keeps its cookies. The shop's cookies are Secure; supertest's
   * own jar won't return those over plain HTTP (browsers do on localhost), so
   * this one does it by hand.
   */
  const jar = new Map<string, string>();
  const keep = (res: request.Response) => {
    for (const c of ([] as string[]).concat(res.headers['set-cookie'] ?? [])) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const v = pair.slice(i + 1);
      if (v) jar.set(pair.slice(0, i), v);
      else jar.delete(pair.slice(0, i));
    }
    return res;
  };
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const agent = {
    get: async (path: string) => keep(await request(app).get(path).set('Cookie', cookie())),
    post: (path: string) => ({
      type: (_t: string) => ({ send: async (body: object) => keep(await request(app).post(path).set('Cookie', cookie()).type('form').send(body)) }),
    }),
  };
  const token = async (path = '/cart') => {
    const html = (await agent.get(path)).text;
    return /name="_csrf" value="([^"]+)"/.exec(html)?.[1] ?? '';
  };
  return { app, catalog, orders, work, agent, token, clock };
}

describe('preview gate (03 §9, ADR-0039)', () => {
  it('asks for the key everywhere except the exempt paths', async () => {
    const { app } = setup({ gate: true, key: 'open-sesame' });
    const home = await request(app).get('/');
    expect(home.status).toBe(401);
    expect(home.text).toContain('Preview key');
    expect((await request(app).get('/p/art/w1')).status).toBe(401);
    expect((await request(app).get('/cart')).status).toBe(401);
    // Printful, Stripe, probes and art's check get through (404 here only because the files don't exist).
    for (const p of ['/img/x', '/files/x', '/mockups/x', '/static/x', '/webhooks/stripe']) {
      expect((await request(app).get(p)).status, p).not.toBe(401);
    }
    const offers = await request(app).get('/api/offers?source=art');
    expect(offers.status).toBe(200);
    expect(offers.body).toEqual({ source: 'art', works: [] });
  });

  it('a wrong key is refused; the right key sets a cookie that is not the key', async () => {
    const t = setup({ gate: true, key: 'open-sesame' });
    const tok = /name="_csrf" value="([^"]+)"/.exec((await t.agent.get('/')).text)![1];
    expect((await t.agent.post('/preview').type('form').send({ _csrf: tok, key: 'wrong', back: '/' })).status).toBe(401);
    const ok = await t.agent.post('/preview').type('form').send({ _csrf: tok, key: 'open-sesame' });
    expect(ok.status).toBe(303);
    expect(ok.headers.location).toBe('/');
    const cookie = (ok.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('shop_preview='))!;
    expect(cookie).not.toContain('open-sesame');
    expect((await t.agent.get('/')).status).toBe(200);
    // Never an open redirect: the form's target is ignored.
    const evil = await t.agent.post('/preview').type('form').send({ _csrf: tok, key: 'open-sesame', back: '//evil.example.net' });
    expect(evil.headers.location).toBe('/');
  });

  it('an admin session passes the gate', async () => {
    const t = setup({ gate: true, key: 'k' });
    const s = signSession(SECRET, { email: 'admin@example.com', exp: t.clock.now() + 60_000 });
    expect((await request(t.app).get('/').set('Cookie', `${SESSION_COOKIE}=${s}`)).status).toBe(200);
  });

  it('test shops carry the banner and noindex; live does not', async () => {
    const test = await request(setup().app).get('/');
    expect(test.text).toContain('Test shop — nothing is charged or shipped.');
    expect(test.text).toContain('<meta name="robots" content="noindex">');
    expect(test.headers['x-robots-tag']).toBe('noindex');
    const live = await request(setup({ mode: 'live' }).app).get('/');
    expect(live.text).not.toContain('Test shop');
    expect(live.headers['x-robots-tag']).toBeUndefined();
  });
});

describe('picture pages (03 §3)', () => {
  it('shows only sellable offers, with the orientation in the name; the alias works', async () => {
    const t = setup();
    t.work('w1', ['print-8x10', 'mug-11oz']);
    t.catalog.exec("UPDATE provider_files SET status = 'waiting' WHERE print_file_sha LIKE 'w1-mug%'");
    const res = await request(t.app).get('/p/art/w1');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Prints of the painting <cite>Work w1</cite>');
    expect(res.text).toContain('Art print 8 × 10 in, landscape');
    expect(res.text).toContain('$32.00');
    expect(res.text).not.toContain('Mug 11 oz');
    expect(res.text).toContain('max="3"');
    expect((await request(t.app).get('/p/w1')).text).toContain('Work w1');
  });

  it('a known work without offers says so; an unknown one is 404', async () => {
    const t = setup();
    t.work('w2', [], 0);
    const none = await request(t.app).get('/p/art/w2');
    expect(none.status).toBe(200);
    expect(none.text).toContain("aren't available");
    expect(none.text).toContain('href="https://art.example.com/?id=w2"');
    expect((await request(t.app).get('/p/art/nope')).status).toBe(404);
    expect((await request(t.app).get('/p/other/w2')).status).toBe(404);
  });

  it('/api/offers lists works with a sellable offer when the gate is off', async () => {
    const t = setup({ mode: 'live' });
    t.work('w1', ['print-8x10']);
    t.work('w2', []);
    expect((await request(t.app).get('/api/offers?source=art')).body).toEqual({ source: 'art', works: ['w1'] });
    expect((await request(t.app).get('/api/offers?source=nope')).status).toBe(404);
  });
});

describe('cart (03 §4)', () => {
  it('adds, merges, updates, removes; the header counts items; a change drops the quote', async () => {
    const t = setup();
    t.work('w1', ['print-8x10', 'postcard-4x6']);
    const tok = await t.token('/p/art/w1');
    const add = (sku: string, quantity: number, mode?: string) =>
      t.agent.post('/cart/items').type('form').send({ _csrf: tok, source: 'art', work: 'w1', sku, quantity, ...(mode ? { mode } : {}) });
    expect((await add('print-8x10', 1)).status).toBe(303);
    await add('print-8x10', 1);
    await add('postcard-4x6', 2);
    const cart = await t.agent.get('/cart');
    expect(cart.headers['cache-control']).toBe('no-store');
    expect(cart.text).toContain('Cart (4)');
    expect(cart.text).toContain('Subtotal: $72.00'); // 2 × 32 + 2 × 4
    const cartRow = t.orders.prepare('SELECT id FROM carts').get() as { id: string };
    t.orders.prepare("UPDATE carts SET quote_id = 'q1' WHERE id = ?").run(cartRow.id);
    await add('postcard-4x6', 1, 'set');
    expect(t.orders.prepare('SELECT quote_id FROM carts').get()).toEqual({ quote_id: null });
    await add('postcard-4x6', 0, 'set');
    expect(t.orders.prepare('SELECT sku_id, quantity FROM cart_items').all()).toEqual([{ sku_id: 'print-8x10', quantity: 2 }]);
  });

  it('enforces the limits per product and per order, with the contact hint', async () => {
    const t = setup();
    t.work('w1', ['print-8x10', 'postcard-4x6']);
    const tok = await t.token('/p/art/w1');
    const add = (sku: string, quantity: number) => t.agent.post('/cart/items').type('form').send({ _csrf: tok, source: 'art', work: 'w1', sku, quantity });
    const tooMany = await add('print-8x10', 4);
    expect(tooMany.status).toBe(409);
    expect(tooMany.text).toContain('At most 3 of this product per order');
    await add('print-8x10', 3);
    const order = await add('postcard-4x6', 3);
    expect(order.status).toBe(409);
    expect(order.text).toContain('At most 5 items per order');
  });

  it('refuses a missing form token, unknown products and unsellable ones', async () => {
    const t = setup();
    t.work('w1', ['print-8x10']);
    expect((await request(t.app).post('/cart/items').type('form').send({ source: 'art', work: 'w1', sku: 'print-8x10', quantity: 1 })).status).toBe(403);
    const tok = await t.token('/p/art/w1');
    expect((await t.agent.post('/cart/items').type('form').send({ _csrf: tok, source: 'art', work: 'w1', sku: 'nope', quantity: 1 })).status).toBe(400);
    expect((await t.agent.post('/cart/items').type('form').send({ _csrf: tok, source: 'art', work: 'w1', sku: 'mug-11oz', quantity: 1 })).status).toBe(409);
    expect((await t.agent.post('/cart/items').type('form').send({ _csrf: tok, source: 'art', work: 'w1', sku: 'print-8x10', quantity: -1 })).status).toBe(400);
  });

  it('marks a line that stopped being sellable', async () => {
    const t = setup();
    t.work('w1', ['print-8x10']);
    const tok = await t.token('/p/art/w1');
    await t.agent.post('/cart/items').type('form').send({ _csrf: tok, source: 'art', work: 'w1', sku: 'print-8x10', quantity: 1 });
    t.catalog.exec("UPDATE works SET enabled = 0");
    const cart = await t.agent.get('/cart');
    expect(cart.text).toContain('no longer available');
    expect(cart.text).toContain('Remove the products that are no longer available');
  });
});
