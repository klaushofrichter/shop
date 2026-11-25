import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { syncShipments } from '../src/orders/fulfilment-events';
import { newestAttempt } from '../src/orders/submit';
import { ADDRESS, paidOrder, startHarness, visitor, type Harness } from './helpers/harness';

// docs/reviews/2026-11-25-code-review.md: one test per finding, failing before its fix.

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(() => h.close());
const db = () => h.shop.dbs.orders;

describe('F7: public forms refuse a request without a form body', () => {
  it('a JSON body to /cart/items and an empty body to /order/find answer 403, not 500', async () => {
    const json = await fetch(`${h.shopUrl}/cart/items`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"sku":"x"}' });
    expect(json.status).toBe(403);
    const empty = await fetch(`${h.shopUrl}/order/find`, { method: 'POST' });
    expect(empty.status).toBe(403);
  });
});

describe('F8: paying an older checkout keeps what was added since', () => {
  async function checkout(v: ReturnType<typeof visitor>, extra?: string) {
    const p = await v.go('GET', '/p/art/w1');
    const tok = v.token(p.text);
    await v.go('POST', '/cart/items', { _csrf: tok, source: 'art', work: 'w1', sku: 'print-8x10', quantity: 1 });
    await v.go('POST', '/cart/address', { _csrf: tok, ...ADDRESS });
    const q = await v.go('GET', '/quote');
    await v.go('POST', '/checkout', { _csrf: tok, quote: /name="quote" value="([^"]+)"/.exec(q.text)![1], shipping: 'STANDARD' });
    if (extra) await v.go('POST', '/cart/items', { _csrf: tok, source: 'art', work: 'w1', sku: extra, quantity: 1 });
    return db().prepare('SELECT stripe_session_id s, cart_id c FROM orders ORDER BY created_at DESC, rowid DESC LIMIT 1').get() as { s: string; c: string };
  }
  const items = (cart: string) => (db().prepare('SELECT sku_id FROM cart_items WHERE cart_id = ? ORDER BY sku_id').all(cart) as Array<{ sku_id: string }>).map((r) => r.sku_id);

  it('the item added after starting checkout stays in the cart', async () => {
    const o = await checkout(visitor(h.shopUrl), 'framed-12x16-black');
    await h.stripe.pay(o.s);
    await h.shop.runner.tick();
    expect(items(o.c)).toEqual(['framed-12x16-black', 'print-8x10']);
  });

  it('an unchanged cart is emptied by the payment', async () => {
    const o = await checkout(visitor(h.shopUrl));
    await h.stripe.pay(o.s);
    await h.shop.runner.tick();
    expect(items(o.c)).toEqual([]);
  });
});

describe('F6: a fraud warning after a full refund leaves nothing stranded', () => {
  it('full Dashboard refund, then an early fraud warning: no requested refund, no open hold, complete', async () => {
    h.printful.scenario({ costFactor: 10 }); // keep it at the draft, held by the cost guard
    const id = await paidOrder(h);
    for (let i = 0; i < 10; i++) {
      await h.shop.runner.tick();
      h.clock.advance(6_000);
    }
    const ch = [...h.stripe.charges.values()][0];
    await h.stripe.dashboardRefund(ch.id, ch.amount - ch.refunded);
    for (let i = 0; i < 10; i++) {
      await h.shop.runner.tick();
      h.clock.advance(6_000);
    }
    expect((db().prepare('SELECT payment_state FROM orders WHERE id = ?').get(id) as { payment_state: string }).payment_state).toBe('refunded');
    await h.stripe.earlyFraudWarning(ch.id);
    for (let i = 0; i < 10; i++) {
      await h.shop.runner.tick();
      h.clock.advance(6_000);
    }
    expect(db().prepare("SELECT COUNT(*) n FROM refunds WHERE order_id = ? AND state = 'requested'").get(id)).toEqual({ n: 0 });
    expect(db().prepare('SELECT COUNT(*) n FROM holds WHERE order_id = ? AND resolved_at IS NULL').get(id)).toEqual({ n: 0 });
    expect(db().prepare('SELECT dispute_state, completed_at FROM orders WHERE id = ?').get(id)).toEqual({ dispute_state: 'warning', completed_at: expect.any(String) });
  });
});

describe('F2: a parcel first seen as pending still gets its shipped e-mail', () => {
  it('synced as pending, then as shipped: one e-mail; synced as shipped again: still one', async () => {
    const id = await paidOrder(h);
    for (let i = 0; i < 10; i++) {
      await h.shop.runner.tick();
      h.clock.advance(6_000);
    }
    const a = newestAttempt(db(), id)!;
    expect(a.state).toBe('confirmed');
    const deps = { orders: db(), clock: h.clock, provider: h.shop.provider!, log: () => {} };
    await syncShipments(deps, a); // the hourly sweep sees the parcel while it is pending
    expect(db().prepare("SELECT shipment_status FROM shipments WHERE order_id = ?").get(id)).toEqual({ shipment_status: 'pending' });
    const mails = () => db().prepare("SELECT COUNT(*) n FROM jobs WHERE kind = 'email.send' AND key LIKE ?").get(`${id}/shipped/%`) as { n: number };
    expect(mails().n).toBe(0);
    const pf = [...h.printful.orders.values()][0];
    await h.printful.ship(pf.id); // shipment_sent
    for (let i = 0; i < 5; i++) await h.shop.runner.tick();
    expect(mails().n).toBe(1);
    await syncShipments(deps, a);
    expect(mails().n).toBe(1);
    expect(db().prepare("SELECT COUNT(*) n FROM emails WHERE order_id = ? AND kind = 'shipped' AND sent_at IS NOT NULL").get(id)).toEqual({ n: 1 });
  });
});

describe('F4: the retry window applies after the draft exists, counted from the first failure', () => {
  const holds = (id: string) => (db().prepare('SELECT reasons_json FROM holds WHERE order_id = ? AND resolved_at IS NULL').all(id) as Array<{ reasons_json: string }>).map((x) => x.reasons_json);
  it('a draft, then Printful answers 500 past the window: a provider_unavailable hold', async () => {
    const id = await paidOrder(h);
    await h.shop.runner.tick(); // the draft is created; costs calculating
    expect(newestAttempt(db(), id)?.state).toBe('draft');
    h.printful.scenario({ status: { code: 500, count: 100_000 } });
    for (let i = 0; i < 80 && !holds(id).length; i++) {
      h.clock.advance(30 * 60_000);
      await h.shop.runner.tick();
    }
    expect(holds(id)).toContain('["provider_unavailable"]');
    // Not before the window: the first failure started the clock.
    const opened = db().prepare("SELECT since FROM holds WHERE order_id = ?").get(id) as { since: string };
    const first = db().prepare("SELECT failing_since FROM provider_orders WHERE order_id = ?").get(id) as { failing_since: string };
    expect(Date.parse(opened.since) - Date.parse(first.failing_since)).toBeGreaterThan(24 * 3_600_000);
  });

  it('the draft is gone at Printful: the attempt is deleted and a hold is open', async () => {
    const id = await paidOrder(h);
    await h.shop.runner.tick();
    const pf = [...h.printful.orders.values()][0];
    h.printful.orders.delete(pf.id);
    h.clock.advance(6_000);
    await h.shop.runner.tick();
    expect(newestAttempt(db(), id)?.state).toBe('deleted');
    expect(holds(id)).toEqual(['["provider_order_missing"]']);
  });
});

describe('F1: a Stripe failure at checkout does not lock the cart', () => {
  it('503 on the first session create; the next Pay from the same cart reaches Stripe, one open order', async () => {
    h.stripe.control.failNextSessionCreate = true;
    const v = visitor(h.shopUrl);
    const p = await v.go('GET', '/p/art/w1');
    const tok = v.token(p.text);
    await v.go('POST', '/cart/items', { _csrf: tok, source: 'art', work: 'w1', sku: 'print-8x10', quantity: 1 });
    await v.go('POST', '/cart/address', { _csrf: tok, ...ADDRESS });
    const q = await v.go('GET', '/quote');
    const quote = /name="quote" value="([^"]+)"/.exec(q.text)![1];
    const first = await v.go('POST', '/checkout', { _csrf: tok, quote, shipping: 'STANDARD' });
    expect(first.status).toBe(503);
    const second = await v.go('POST', '/checkout', { _csrf: tok, quote, shipping: 'STANDARD' });
    expect(second.status).toBe(303);
    expect(second.location).toMatch(/cs_mock_/);
    const open = db().prepare("SELECT id, stripe_session_id FROM orders WHERE payment_state = 'checkout_open'").all() as Array<{ id: string; stripe_session_id: string }>;
    expect(open).toHaveLength(1);
    expect(second.location).toContain(open[0].stripe_session_id);
    // The repeat used the order's own keys: one Customer for that order, not a second order.
    expect(db().prepare('SELECT COUNT(*) n FROM orders').get()).toEqual({ n: 1 });
  });
});

describe('a refused checkout says why in the log', () => {
  it('logs Stripe type, code, param and message, without the e-mail it quotes', async () => {
    h.stripe.control.rejectNextSessionCreate = {
      type: 'invalid_request_error', code: 'parameter_invalid', param: 'automatic_tax[enabled]',
      message: 'Stripe Tax is not set up for jane@example.com',
    };
    const spy = vi.spyOn(console, 'log');
    try {
      const v = visitor(h.shopUrl);
      const p = await v.go('GET', '/p/art/w1');
      const tok = v.token(p.text);
      await v.go('POST', '/cart/items', { _csrf: tok, source: 'art', work: 'w1', sku: 'print-8x10', quantity: 1 });
      await v.go('POST', '/cart/address', { _csrf: tok, ...ADDRESS });
      const q = await v.go('GET', '/quote');
      const quote = /name="quote" value="([^"]+)"/.exec(q.text)![1];
      await v.go('POST', '/checkout', { _csrf: tok, quote, shipping: 'STANDARD' });
      const line = spy.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>).find((l) => l.msg === 'checkout refused by Stripe')!;
      expect(line).toMatchObject({ status: 400, type: 'invalid_request_error', code: 'parameter_invalid', param: 'automatic_tax[enabled]' });
      expect(line.message).toBe('stripe: Stripe Tax is not set up for [email]');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('F5: the cost half of the circuit breaker (ADR-0042)', () => {
  it('over the cost limit with the order count below its limit: held with reason breaker, and an alert', async () => {
    h.close();
    h = await startHarness({ BREAKER_COST_CENTS_24H: '1000' }); // one 8 × 10 print costs more than $10 at Printful
    const id = await paidOrder(h);
    expect(db().prepare('SELECT reasons_json FROM holds WHERE order_id = ?').get(id)).toEqual({ reasons_json: '["breaker"]' });
    expect(db().prepare("SELECT COUNT(*) n FROM jobs WHERE kind = 'alert.send'").get()).not.toEqual({ n: 0 });
  });

  it('under both limits: no hold', async () => {
    const id = await paidOrder(h);
    expect(db().prepare('SELECT COUNT(*) n FROM holds WHERE order_id = ?').get(id)).toEqual({ n: 0 });
  });
});

describe('transitions write history (review §4)', () => {
  it('completion and every hold resolution leave a line in the order history; a dispute change is conditional', async () => {
    h.printful.scenario({ refuseNextOrder: true }); // a hold that refunds at once, then completion
    const id = await paidOrder(h);
    for (let i = 0; i < 12; i++) {
      await h.shop.runner.tick();
      h.clock.advance(61_000);
    }
    const ev = (db().prepare("SELECT part, to_value FROM order_events WHERE order_id = ? AND part IN ('hold', 'note') ORDER BY id").all(id) as Array<{ part: string; to_value: string }>).map((e) => `${e.part}:${e.to_value}`);
    expect(ev).toContain('hold:attention');
    expect(ev.some((e) => e === 'hold:expired' || e === 'hold:refunded')).toBe(true);
    expect(ev).toContain('note:complete');
    const { setDispute } = await import('../src/orders/holds.js');
    expect(setDispute(db(), h.clock, id, ['open'], 'won', 'test')).toBe(false); // not open: nothing changes
    expect(db().prepare('SELECT dispute_state FROM orders WHERE id = ?').get(id)).toEqual({ dispute_state: 'none' });
  });
});
