import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { statusToken } from '../src/orders/ids';
import { signPrintfulWebhook, verifyPrintfulWebhook } from '../src/providers/printful-webhook';
import { PF_PUBLIC_KEY, PF_SECRET, paidOrder, startHarness, type Harness } from './helpers/harness';

// docs/design/06 §3, §5, 07 §2.3–2.7: Printful's webhooks over HTTP from the
// mock, verified, stored once, re-fetched and applied by the job.

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(() => h.close());

const order = (id: string) => h.shop.dbs.orders.prepare('SELECT * FROM orders WHERE id = ?').get(id) as Record<string, any>;
const openHolds = (id: string) =>
  (h.shop.dbs.orders.prepare('SELECT kind, reasons_json FROM holds WHERE order_id = ? AND resolved_at IS NULL').all(id) as Array<{ kind: string; reasons_json: string }>).map((x) => `${x.kind}:${x.reasons_json}`);
const events = () => h.shop.dbs.orders.prepare("SELECT type, outcome FROM inbound_events WHERE provider = 'printful' ORDER BY received_at, rowid").all() as Array<{ type: string; outcome: string }>;
async function settle() {
  for (let i = 0; i < 20; i++) {
    if ((await h.shop.runner.tick()) === 0) {
      const next = h.shop.dbs.orders.prepare("SELECT MIN(run_after) t FROM jobs WHERE state = 'queued' AND kind IN ('order.submit', 'printful.event')").get() as { t: string | null };
      if (!next.t) return;
      h.clock.advance(Math.max(0, Date.parse(next.t) - h.clock.now()) + 1);
    }
  }
}
async function submitted() {
  const id = await paidOrder(h);
  await settle();
  expect(order(id).fulfilment_state).toBe('submitted');
  const pf = [...h.printful.orders.values()].find((o) => o.externalId === `${id}-1`)!;
  return { id, pf };
}

describe('verification (06 §3)', () => {
  const cfg = { secretHex: PF_SECRET, publicKey: PF_PUBLIC_KEY, storeId: '10000001' };
  const now = Date.UTC(2026, 10, 26, 15);
  const body = (o: Record<string, unknown> = {}) =>
    Buffer.from(JSON.stringify({ type: 'order_updated', occurred_at: new Date(now).toISOString(), store_id: 10000001, data: { order: { id: 1, external_id: 'x-1' } }, ...o }));
  const check = (raw: Buffer, sig = signPrintfulWebhook(raw, PF_SECRET), pk = PF_PUBLIC_KEY) => verifyPrintfulWebhook(raw, { signature: sig, publicKey: pk }, cfg, now);

  it('accepts a signed delivery and derives a stable event id', () => {
    const a = check(body());
    const b = check(body());
    expect(a.ok && b.ok && a.event.eventId === b.event.eventId).toBe(true);
    expect(a.ok && a.event).toMatchObject({ type: 'order_updated', providerOrderId: '1', externalId: 'x-1' });
  });

  it('refuses a bad signature, another public key, another store, a stale event', () => {
    expect(check(body(), 'ff'.repeat(32))).toEqual({ ok: false, reason: 'signature' });
    expect(check(body(), undefined, 'other')).toEqual({ ok: false, reason: 'public key' });
    expect(check(body({ store_id: 42 }))).toEqual({ ok: false, reason: 'store' });
    expect(check(body({ occurred_at: new Date(now - 25 * 3_600_000).toISOString() }))).toEqual({ ok: false, reason: 'stale' });
  });

  it('the endpoint answers 400 to a forged delivery and stores nothing', async () => {
    const raw = body();
    const res = await fetch(`${h.shopUrl}/webhooks/printful`, { method: 'POST', body: raw, headers: { 'x-pf-webhook-signature': 'ff'.repeat(32), 'x-pf-webhook-public-key': PF_PUBLIC_KEY } });
    expect(res.status).toBe(400);
    expect(events()).toEqual([]);
  });
});

describe('order progress (06 §5)', () => {
  it('in production, shipped (tracking, one e-mail per parcel), delivered and complete', async () => {
    const { id, pf } = await submitted();
    await h.printful.advance(pf.id, 'inprocess');
    await settle();
    expect(order(id).fulfilment_state).toBe('in_production');

    const sh = await h.printful.ship(pf.id);
    await settle();
    expect(order(id).fulfilment_state).toBe('shipped');
    const row = h.shop.dbs.orders.prepare('SELECT * FROM shipments WHERE id = ?').get(String(sh)) as Record<string, any>;
    expect(row).toMatchObject({ order_id: id, attempt: 1, carrier: 'USPS', tracking_number: `9400000000000${sh}`, shipment_status: 'shipped', delivery_status: 'in_transit' });
    expect(row.estimated_from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // The order page lists the parcel with its tracking link.
    const token = statusToken('s'.repeat(40), id);
    const page = await fetch(`${h.shopUrl}/order/${id}`, { headers: { cookie: `shop_order=${token}` } });
    const html = await page.text();
    expect(html).toContain('Parcel 1: USPS (USPS Ground Advantage), tracking <a href="https://tools.usps.com/');
    expect(html).toContain('on its way, expected');
    const mails = h.shop.dbs.orders.prepare("SELECT key FROM jobs WHERE kind = 'email.send' AND key LIKE '%/shipped/%'").all() as Array<{ key: string }>;
    expect(mails).toEqual([{ key: `${id}/shipped/${sh}` }]);

    await h.printful.deliver(sh);
    await settle();
    expect(order(id)).toMatchObject({ fulfilment_state: 'delivered', completed_at: expect.any(String) });
    // A late `fulfilled` re-read never undoes the delivery.
    await h.printful.emit('order_updated', pf);
    await settle();
    expect(order(id).fulfilment_state).toBe('delivered');
  });

  it('the same delivery twice is stored and applied once', async () => {
    const { pf } = await submitted();
    await h.printful.advance(pf.id, 'inprocess');
    await h.printful.emit('order_updated', pf);
    await settle();
    expect(events().filter((e) => e.type === 'order_updated')).toHaveLength(1);
  });

  it('a Printful hold opens a provider hold; its removal clears it', async () => {
    const { id, pf } = await submitted();
    await h.printful.advance(pf.id, 'onhold');
    await settle();
    expect(order(id).fulfilment_state).toBe('on_hold');
    expect(openHolds(id)).toEqual(['provider:["provider_hold"]']);
    h.clock.advance(1_000);
    await h.printful.advance(pf.id, 'pending');
    await settle();
    expect(openHolds(id)).toEqual([]);
    expect(order(id).fulfilment_state).toBe('submitted');
  });

  it('Printful cancels: an attention hold that refunds; a cancel the shop made opens none', async () => {
    const { id, pf } = await submitted();
    await h.printful.advance(pf.id, 'canceled');
    await settle();
    expect(order(id).fulfilment_state).toBe('canceled');
    expect(openHolds(id)).toEqual(['attention:["provider_canceled"]']);

    const b = await submitted();
    h.shop.dbs.orders.prepare("UPDATE provider_orders SET state = 'canceled' WHERE order_id = ?").run(b.id); // as the shop's own cancel records it (7c)
    await h.printful.advance(b.pf.id, 'canceled');
    await settle();
    expect(openHolds(b.id)).toEqual([]);
    expect(events().at(-1)?.outcome).toBe('own cancel');
  });

  it('order_failed after confirmation: an attention hold', async () => {
    const { id, pf } = await submitted();
    await h.printful.advance(pf.id, 'failed');
    await settle();
    expect(order(id).fulfilment_state).toBe('failed');
    expect(openHolds(id)).toEqual(['attention:["provider_failed"]']);
  });
});
