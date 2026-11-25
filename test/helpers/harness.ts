/**
 * The shop with mock Printful and mock Stripe over HTTP, a fake clock and a
 * seeded sellable work: shared by the order tests (checkout, submission).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMockPrintful, type MockPrintful } from '../../mocks/printful/server';
import { createMockStripe, type MockStripe } from '../../mocks/stripe/server';
import { createMockSes } from '../../mocks/ses/server';
import { FakeClock } from '../../src/clock';
import { startShop, type Shop } from '../../src/startup';

export const WEBHOOK_SECRET = 'whsec_mock_harness';
export const PF_SECRET = 'ab'.repeat(32);
export const PF_PUBLIC_KEY = 'mock-pf-public-key';

const listen = async (app: { listen(port: number): Server }) => {
  const s = app.listen(0);
  await new Promise((r) => s.once('listening', r));
  return { s, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
};

export interface Harness {
  clock: FakeClock;
  printful: MockPrintful;
  stripe: MockStripe;
  ses: ReturnType<typeof createMockSes>;
  shop: Shop;
  shopUrl: string;
  close(): void;
}

export async function startHarness(env: Record<string, string> = {}): Promise<Harness> {
  const clock = new FakeClock(Date.UTC(2026, 10, 26, 15));
  const pfWebhook = { target: '', secretHex: PF_SECRET, publicKey: PF_PUBLIC_KEY };
  const printful = createMockPrintful({ clock, webhook: pfWebhook });
  const stripeOpts = { clock, webhookSecret: WEBHOOK_SECRET, checkoutBase: 'http://checkout.invalid/pay', webhookTarget: '' };
  const stripe = createMockStripe(stripeOpts);
  const pf = await listen(printful.app);
  const st = await listen(stripe.app);
  const ses = createMockSes({ accessKeyId: 'mock_ses_h', secretAccessKey: 'mock-ses-secret' });
  const se = await listen(ses.app);
  const dir = mkdtempSync(path.join(tmpdir(), 'shop-h-'));
  const shop = startShop(
    {
      SHOP_MODE: 'mock', DATA_DIR: dir, PRINTFUL_BASE_URL: pf.url, PRINTFUL_TOKEN: 'mock_printful_1',
      STRIPE_API_BASE: st.url, STRIPE_SECRET_KEY: 'mock_stripe_1', STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      STATUS_TOKEN_SECRET: 's'.repeat(40), COOKIE_SECRET: 'c'.repeat(40),
      APPROVAL_OVER_CENTS: '20000', REPEAT_OVER_CENTS: '50000', REPEAT_ORDERS: '3', BREAKER_ORDERS_24H: '10',
      BREAKER_COST_CENTS_24H: '100000', MAX_ITEMS_PER_ORDER: '10', MAX_ORDER_CENTS: '100000', SKU_MAX_QUANTITY: '{"default":9}',
      PRINTFUL_WEBHOOK_SECRET: PF_SECRET, PRINTFUL_WEBHOOK_PUBLIC_KEY: PF_PUBLIC_KEY,
      SES_ENDPOINT: se.url.replace('127.0.0.1', 'localhost'), SHOP_SES_AWS_ACCESS_KEY_ID: 'mock_ses_h', SHOP_SES_AWS_SECRET_ACCESS_KEY: 'mock-ses-secret',
      EMAIL_ENABLED: 'on', EMAIL_ALLOWLIST: 'jane@example.com', ALERT_EMAIL: 'alerts@example.com', SES_FEEDBACK_ADDRESS: 'bounces@example.com',
      PACKING_SLIP_EMAIL: 'orders@example.com', PACKING_SLIP_PHONE: '+1 555 010 0000',
      ...env,
    },
    clock,
  );
  await shop.ready();
  await shop.runner.tick(); // the start-up jobs (catalog check) out of the way
  const s = await listen(shop.app);
  stripeOpts.webhookTarget = `${s.url}/webhooks/stripe`;
  pfWebhook.target = `${s.url}/webhooks/printful`;
  const c = shop.dbs.catalog;
  c.exec(`INSERT INTO works (source_id, work_id, title, canonical_url, original_url, prints_allowed, enabled, seen_at) VALUES ('art', 'w1', 'Undertow', 'u', 'u', 1, 1, 'now')`);
  for (const [sku, wholesale] of [['print-8x10', 825], ['framed-12x16-black', 3375]] as const) {
    const sha = sku.padEnd(64, '0');
    c.prepare(`INSERT INTO print_files (sha256, render_key, path, width_px, height_px, bytes, created_at) VALUES (?, ?, ?, 1, 1, 1, 'now')`).run(sha, sha, `/files/${sha}.jpg`);
    c.prepare(`INSERT INTO offers (source_id, work_id, sku_id, enabled, print_file_sha, orientation) VALUES ('art', 'w1', ?, 1, ?, 'portrait')`).run(sku, sha);
    c.prepare(`INSERT INTO provider_files (print_file_sha, provider, store, status, checked_at) VALUES (?, 'printful', 'mock', 'ok', 'now')`).run(sha);
    c.prepare(`INSERT OR REPLACE INTO sku_checks (sku_id, ok, wholesale_cents, checked_at) VALUES (?, 1, ?, 'now')`).run(sku, wholesale);
  }
  return {
    clock, printful, stripe, ses, shop, shopUrl: s.url,
    close() {
      s.s.close();
      pf.s.close();
      st.s.close();
      se.s.close();
      shop.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A browser: cookies kept by hand (the shop's are Secure), redirects not followed. */
export function visitor(shopUrl: string) {
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

export const ADDRESS = { name: 'Jane Doe', email: 'jane@example.com', line1: '1 Main St', city: 'Austin', state: 'TX', zip: '78701' };

/** Cart → address → quote → checkout → paid at mock Stripe → the webhook applied. Returns the order id. */
export async function paidOrder(h: Harness, sku = 'print-8x10', quantity = 1): Promise<string> {
  const v = visitor(h.shopUrl);
  const p = await v.go('GET', '/p/art/w1');
  const tok = v.token(p.text);
  await v.go('POST', '/cart/items', { _csrf: tok, source: 'art', work: 'w1', sku, quantity });
  await v.go('POST', '/cart/address', { _csrf: tok, ...ADDRESS });
  const q = await v.go('GET', '/quote');
  const quote = /name="quote" value="([^"]+)"/.exec(q.text)![1];
  await v.go('POST', '/checkout', { _csrf: tok, quote, shipping: 'STANDARD' });
  const o = h.shop.dbs.orders.prepare('SELECT id, stripe_session_id FROM orders ORDER BY created_at DESC, rowid DESC LIMIT 1').get() as { id: string; stripe_session_id: string };
  await h.stripe.pay(o.stripe_session_id, { riskLevel: 'normal', fingerprint: `fp-${o.id}` });
  await h.shop.runner.tick(1); // the Stripe event: payment applied, order.submit queued
  return o.id;
}
