import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMockPrintful, type MockPrintful } from '../mocks/printful/server';
import { createMockStripe, type MockStripe } from '../mocks/stripe/server';
import { FakeClock } from '../src/clock';
import { signStripeWebhook } from '../src/payments/stripe';
import { startShop, type Shop } from '../src/startup';

const WEBHOOK_SECRET = 'whsec_mock_checkout';
const clock = new FakeClock(Date.UTC(2026, 10, 26, 15));
let printful: MockPrintful;
let pfServer: Server;
let stripeMock: MockStripe;
let stServer: Server;
const stripeOpts = { clock, webhookSecret: WEBHOOK_SECRET, checkoutBase: 'http://checkout.invalid/pay', webhookTarget: '' };
let shop: Shop;
let shopServer: Server;
let shopUrl: string;
let dir: string;

const listen = async (app: { listen(port: number): Server }) => {
  const s = app.listen(0);
  await new Promise((r) => s.once('listening', r));
  return { s, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
};

beforeAll(async () => {
  printful = createMockPrintful({ clock });
  stripeMock = createMockStripe(stripeOpts);
  const pf = await listen(printful.app);
  const st = await listen(stripeMock.app);
  pfServer = pf.s;
  stServer = st.s;
  (globalThis as Record<string, unknown>).__urls = { pf: pf.url, st: st.url };
});
afterAll(() => {
  pfServer.close();
  stServer.close();
});

beforeEach(async () => {
  printful.reset();
  stripeMock.reset();
  const urls = (globalThis as Record<string, unknown>).__urls as { pf: string; st: string };
  dir = mkdtempSync(path.join(tmpdir(), 'shop-co-'));
  shop = startShop(
    {
      SHOP_MODE: 'mock', DATA_DIR: dir, PRINTFUL_BASE_URL: urls.pf, PRINTFUL_TOKEN: 'mock_printful_1',
      STRIPE_API_BASE: urls.st, STRIPE_SECRET_KEY: 'mock_stripe_1', STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      STATUS_TOKEN_SECRET: 's'.repeat(40), COOKIE_SECRET: 'c'.repeat(40),
      APPROVAL_OVER_CENTS: '20000', REPEAT_OVER_CENTS: '50000', REPEAT_ORDERS: '3', BREAKER_ORDERS_24H: '10',
      BREAKER_COST_CENTS_24H: '100000', MAX_ITEMS_PER_ORDER: '10', MAX_ORDER_CENTS: '100000', SKU_MAX_QUANTITY: '{"default":9}',
    },
    clock,
  );
  await shop.ready();
  const s = await listen(shop.app);
  shopServer = s.s;
  shopUrl = s.url;
  stripeOpts.webhookTarget = `${shopUrl}/webhooks/stripe`;
  // A sellable work (the admin's and Printful's part, seeded).
  const c = shop.dbs.catalog;
  c.exec(`INSERT INTO works (source_id, work_id, title, canonical_url, original_url, prints_allowed, enabled, seen_at) VALUES ('art', 'w1', 'Undertow', 'u', 'u', 1, 1, 'now')`);
  for (const [sku, wholesale] of [['print-8x10', 825], ['framed-12x16-black', 3375]] as const) {
    const sha = sku.padEnd(64, '0');
    c.prepare(`INSERT INTO print_files (sha256, render_key, path, width_px, height_px, bytes, created_at) VALUES (?, ?, ?, 1, 1, 1, 'now')`).run(sha, sha, `/files/${sha}.jpg`);
    c.prepare(`INSERT INTO offers (source_id, work_id, sku_id, enabled, print_file_sha, orientation) VALUES ('art', 'w1', ?, 1, ?, 'portrait')`).run(sku, sha);
    c.prepare(`INSERT INTO provider_files (print_file_sha, provider, store, status, checked_at) VALUES (?, 'printful', 'mock', 'ok', 'now')`).run(sha);
    c.prepare(`INSERT OR REPLACE INTO sku_checks (sku_id, ok, wholesale_cents, checked_at) VALUES (?, 1, ?, 'now')`).run(sku, wholesale);
  }
});
afterEach(() => {
  shopServer.close();
  shop.stop();
  rmSync(dir, { recursive: true, force: true });
});

/** A browser: cookies kept by hand (the shop's are Secure; see public.test.ts), redirects not followed. */
function visitor() {
  const jar = new Map<string, string>();
  async function go(method: 'GET' | 'POST', p: string, form?: Record<string, string | number>) {
    const res = await fetch(shopUrl + p, {
      method,
      redirect: 'manual',
      headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body: form ? new URLSearchParams(Object.entries(form).map(([k, v]) => [k, String(v)])).toString() : undefined,
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const v = pair.slice(i + 1);
      if (v) jar.set(pair.slice(0, i), v);
      else jar.delete(pair.slice(0, i));
    }
    return { status: res.status, location: res.headers.get('location') ?? '', text: await res.text() };
  }
  const token = (html: string) => /name="_csrf" value="([^"]+)"/.exec(html)![1];
  return { go, token, jar };
}

const ADDRESS = { name: 'Jane Doe', email: 'jane@example.com', line1: '1 Main St', city: 'Austin', state: 'TX', zip: '78701' };

async function toQuote(v: ReturnType<typeof visitor>, sku = 'print-8x10', quantity = 1) {
  const p = await v.go('GET', '/p/art/w1');
  const tok = v.token(p.text);
  await v.go('POST', '/cart/items', { _csrf: tok, source: 'art', work: 'w1', sku, quantity });
  await v.go('POST', '/cart/address', { _csrf: tok, ...ADDRESS });
  const q = await v.go('GET', '/quote');
  const quote = /name="quote" value="([^"]+)"/.exec(q.text)![1];
  return { tok, quote };
}

const order = () => shop.dbs.orders.prepare('SELECT * FROM orders ORDER BY created_at DESC, rowid DESC LIMIT 1').get() as Record<string, unknown>;
const jobs = (kind: string) => shop.dbs.orders.prepare('SELECT key, state FROM jobs WHERE kind = ?').all(kind) as Array<{ key: string; state: string }>;
const holds = () => shop.dbs.orders.prepare('SELECT kind, reasons_json, deadline_action FROM holds').all() as Array<Record<string, string>>;

describe('checkout → payment (05 §3–5, 07 §2.1)', () => {
  it('creates the order, a Customer and a session with the design’s parameters, and sends the customer to Stripe', async () => {
    const v = visitor();
    const { tok, quote } = await toQuote(v);
    const res = await v.go('POST', '/checkout', { _csrf: tok, quote, shipping: 'STANDARD' });
    expect(res.status).toBe(303);
    expect(res.location).toMatch(/^http:\/\/checkout\.invalid\/pay\/cs_mock_/);
    const o = order();
    expect(o).toMatchObject({ payment_state: 'checkout_open', email: 'jane@example.com', ship_state: 'TX', items_cents: 3200 });
    expect(String(o.number)).toMatch(/^\d{5}$/);
    const sent = stripeMock.requests.find((r) => r.path === '/v1/checkout/sessions')!.body as Record<string, any>;
    expect(sent).toMatchObject({
      mode: 'payment', client_reference_id: o.id, metadata: { order_id: o.id },
      payment_intent_data: { description: `Order ${o.number}` }, allow_promotion_codes: 'false',
      consent_collection: { terms_of_service: 'required' }, automatic_tax: { enabled: 'true' },
    });
    expect(Object.values(sent.payment_method_types)).toEqual(['card', 'link']);
    expect(sent.custom_text.submit.message).toBe('Ships to Jane Doe, 1 Main St, Austin, TX 78701');
    expect(sent.line_items['0'].price_data.product_data.metadata.order_item_id).toBe(`${o.id}-1`);
    expect(sent.shipping_options['0'].shipping_rate_data.tax_code).toBe('txcd_92010001');
    expect(sent.shipping_address_collection).toBeUndefined();
    // The Customer carries no phone (ADR-0031).
    expect(JSON.stringify(stripeMock.requests.find((r) => r.path === '/v1/customers')!.body)).not.toMatch(/phone/);
  });

  it('a payment arrives by webhook: paid, fail-safes checked, submit and confirmation queued, the cart emptied', async () => {
    const v = visitor();
    const { tok, quote } = await toQuote(v);
    await v.go('POST', '/checkout', { _csrf: tok, quote, shipping: 'STANDARD' });
    const o = order();
    // Stripe delivers the event twice: stored once, both answered 200.
    stripeMock.control.duplicateNext = true;
    await stripeMock.pay(String(o.stripe_session_id), { riskLevel: 'normal', fingerprint: 'fp1' });
    expect(stripeMock.deliveries.map((x) => x.status)).toEqual([200, 200]);
    expect(shop.dbs.orders.prepare('SELECT type FROM inbound_events').all()).toEqual([{ type: 'checkout.session.completed' }]);
    await shop.runner.tick();
    const paid = order();
    expect(paid).toMatchObject({ payment_state: 'paid', card_fingerprint: 'fp1', radar_risk_level: 'normal' });
    expect(paid.tax_cents).toBe(Math.round(3200 * 0.0825) + Math.round(Number(paid.shipping_cents) * 0.0825));
    expect(paid.failsafe_checked_at).toBeTruthy();
    expect(holds()).toEqual([]);
    expect(jobs('order.submit')).toEqual([{ key: String(o.id), state: 'queued' }]);
    expect(jobs('email.send').map((j) => j.key)).toEqual([`${o.id}/confirmation`]);
    expect(shop.dbs.orders.prepare('SELECT COUNT(*) n FROM cart_items').get()).toEqual({ n: 0 });
    expect(shop.dbs.orders.prepare('SELECT tax_cents FROM order_items').get()).toEqual({ tax_cents: 264 });
  });

  it('the success link: token → cookie → clean URL; the page applies a payment the webhook has not brought yet', async () => {
    const v = visitor();
    const { tok, quote } = await toQuote(v);
    await v.go('POST', '/checkout', { _csrf: tok, quote, shipping: 'STANDARD' });
    const o = order();
    stripeMock.control.paused = true; // the webhook is late
    await stripeMock.pay(String(o.stripe_session_id));
    const sessionBody = stripeMock.requests.find((r) => r.path === '/v1/checkout/sessions')!.body as { success_url: string };
    const back = await v.go('GET', new URL(sessionBody.success_url).pathname + new URL(sessionBody.success_url).search);
    expect(back.status).toBe(303);
    expect(back.location).toBe(`/order/${o.id}`);
    const pageRes = await v.go('GET', `/order/${o.id}`);
    expect(pageRes.status).toBe(200);
    expect(pageRes.text).toContain(`Order ${o.number}`);
    expect(pageRes.text).toContain('Payment received');
    expect(pageRes.text).not.toContain('1 Main St'); // name, city and state only
    expect(order().payment_state).toBe('paid');
    // Without the cookie, or with a wrong token: 404.
    expect((await fetch(`${shopUrl}/order/${o.id}`)).status).toBe(404);
    expect((await fetch(`${shopUrl}/order/${o.id}?t=wrong`, { redirect: 'manual' })).status).toBe(404);
  });

  it('Pay twice: the same session; another option: the old session is expired first (I9)', async () => {
    const v = visitor();
    const { tok, quote } = await toQuote(v);
    const a = await v.go('POST', '/checkout', { _csrf: tok, quote, shipping: 'STANDARD' });
    const b = await v.go('POST', '/checkout', { _csrf: tok, quote, shipping: 'STANDARD' });
    expect(b.location).toBe(a.location);
    expect(shop.dbs.orders.prepare('SELECT COUNT(*) n FROM orders').get()).toEqual({ n: 1 });
    const first = order();
    const c = await v.go('POST', '/checkout', { _csrf: tok, quote, shipping: 'STANDARD_CARBON_OFFSET' });
    expect(c.location).not.toBe(a.location);
    expect(stripeMock.sessions.get(String(first.stripe_session_id))!.status).toBe('expired');
    const states = shop.dbs.orders.prepare('SELECT payment_state FROM orders ORDER BY created_at, rowid').all();
    expect(states).toEqual([{ payment_state: 'closed_unpaid' }, { payment_state: 'checkout_open' }]);
  });

  it('paid in another tab: Pay again applies the payment and goes to the order', async () => {
    const v = visitor();
    const { tok, quote } = await toQuote(v);
    await v.go('POST', '/checkout', { _csrf: tok, quote, shipping: 'STANDARD' });
    const o = order();
    stripeMock.control.paused = true;
    await stripeMock.pay(String(o.stripe_session_id));
    const again = await v.go('POST', '/checkout', { _csrf: tok, quote, shipping: 'STANDARD_CARBON_OFFSET' });
    expect(again.location).toContain(`/order/${o.id}?t=`);
    expect(order().payment_state).toBe('paid');
  });

  it('a payment after the checkout was closed is a normal payment (I1)', async () => {
    const v = visitor();
    const { tok, quote } = await toQuote(v);
    await v.go('POST', '/checkout', { _csrf: tok, quote, shipping: 'STANDARD' });
    const o = order();
    await stripeMock.expire(String(o.stripe_session_id));
    await shop.runner.tick();
    expect(order().payment_state).toBe('closed_unpaid');
    // Stripe's state flips to paid after all (the mock allows it only through its control API).
    const ses = stripeMock.sessions.get(String(o.stripe_session_id))!;
    ses.status = 'open';
    await stripeMock.pay(String(o.stripe_session_id));
    await shop.runner.tick();
    expect(order()).toMatchObject({ payment_state: 'paid' });
  });
});

describe('fail-safes in the payment transaction (06 §8, review C F1)', () => {
  it('holds a large or risky order with all its reasons; no submit job', async () => {
    const v = visitor();
    const { tok, quote } = await toQuote(v, 'framed-12x16-black', 3);
    await v.go('POST', '/checkout', { _csrf: tok, quote, shipping: 'STANDARD' });
    await stripeMock.pay(String(order().stripe_session_id), { riskLevel: 'elevated' });
    await shop.runner.tick();
    expect(holds()).toEqual([{ kind: 'approval', reasons_json: '["amount","risk"]', deadline_action: 'refund' }]);
    expect(jobs('order.submit')).toEqual([]);
    expect(order().failsafe_checked_at).toBeTruthy();
  });

  it('an amount that does not match the order is paid and held for attention', async () => {
    const v = visitor();
    const { tok, quote } = await toQuote(v);
    await v.go('POST', '/checkout', { _csrf: tok, quote, shipping: 'STANDARD' });
    shop.dbs.orders.exec('UPDATE orders SET items_cents = items_cents + 1');
    await stripeMock.pay(String(order().stripe_session_id));
    await shop.runner.tick();
    expect(order().payment_state).toBe('paid');
    expect(holds()).toEqual([{ kind: 'attention', reasons_json: '["amount_mismatch"]', deadline_action: 'alert' }]);
  });
});

describe('webhooks and find my order', () => {
  it('refuses a bad signature; a 2017-shaped event works through re-fetching', async () => {
    const bad = await fetch(`${shopUrl}/webhooks/stripe`, { method: 'POST', headers: { 'stripe-signature': 't=1,v1=00' }, body: '{}' });
    expect(bad.status).toBe(400);
    const v = visitor();
    const { tok, quote } = await toQuote(v);
    await v.go('POST', '/checkout', { _csrf: tok, quote, shipping: 'STANDARD' });
    stripeMock.control.oldShapeNext = true;
    await stripeMock.pay(String(order().stripe_session_id));
    await shop.runner.tick();
    expect(order().payment_state).toBe('paid');
    // Only id, type and the object's id are kept of a Stripe event (review C F14).
    expect(shop.dbs.orders.prepare('SELECT payload_json FROM inbound_events').get()).toEqual({ payload_json: null });
    const raw = JSON.stringify({ id: 'evt_x', type: 'x', data: { object: { id: 'y' } } });
    const ok = await fetch(`${shopUrl}/webhooks/stripe`, { method: 'POST', headers: { 'stripe-signature': signStripeWebhook(raw, WEBHOOK_SECRET, clock.now()) }, body: raw });
    expect(ok.status).toBe(200);
  });

  it('find my order e-mails the link on a match and answers the same either way', async () => {
    const v = visitor();
    const { tok, quote } = await toQuote(v);
    await v.go('POST', '/checkout', { _csrf: tok, quote, shipping: 'STANDARD' });
    await stripeMock.pay(String(order().stripe_session_id));
    await shop.runner.tick();
    const o = order();
    const f = visitor();
    const ftok = f.token((await f.go('GET', '/order/find')).text);
    const hit = await f.go('POST', '/order/find', { _csrf: ftok, number: String(o.number), email: 'JANE@example.com' });
    const miss = await f.go('POST', '/order/find', { _csrf: ftok, number: String(o.number), email: 'other@example.com' });
    expect(hit.text).toContain('If the order number and e-mail match');
    expect(miss.text).toContain('If the order number and e-mail match');
    expect(jobs('email.send').filter((j) => j.key.includes('/link/'))).toHaveLength(1);
  });
});
