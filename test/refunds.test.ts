import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { requestFullRefund } from '../src/orders/refunds';
import { paidOrder, startHarness, type Harness } from './helpers/harness';

// docs/design/05 §4, §7; 06 §6–7; 07 §2.2, §2.5, §2.7: refunds, hold
// deadlines with the I4 proof, I7 after a full refund, disputes and early
// fraud warnings, against mock Stripe and mock Printful over HTTP.

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(() => h.close());

const db = () => h.shop.dbs.orders;
const order = (id: string) => db().prepare('SELECT * FROM orders WHERE id = ?').get(id) as Record<string, any>;
const refunds = (id: string) => db().prepare('SELECT purpose, state, amount_cents FROM refunds WHERE order_id = ? ORDER BY id').all(id) as Array<Record<string, any>>;
const openHolds = (id: string) =>
  (db().prepare('SELECT kind, reasons_json, deadline_action FROM holds WHERE order_id = ? AND resolved_at IS NULL').all(id) as Array<Record<string, string>>).map((x) => `${x.kind}:${x.reasons_json}:${x.deadline_action}`);
const attempts = (id: string) => (db().prepare('SELECT state FROM provider_orders WHERE order_id = ? ORDER BY attempt').all(id) as Array<{ state: string }>).map((a) => a.state);
const chargeOf = (id: string) => [...h.stripe.charges.values()].find((c) => c.pi === order(id).stripe_payment_intent)!;
const pfOf = (id: string) => [...h.printful.orders.values()].find((o) => o.externalId === `${id}-1`);
const KINDS = "('order.submit', 'printful.event', 'stripe.event', 'refund.run', 'order.cancel', 'order.fraud_retry', 'holds.deadlines')";
async function settle(maxMs = 10 * 60_000) {
  const end = h.clock.now() + maxMs;
  for (let i = 0; i < 40; i++) {
    if ((await h.shop.runner.tick()) > 1) continue;
    const next = db().prepare(`SELECT MIN(run_after) t FROM jobs WHERE state = 'queued' AND kind IN ${KINDS}`).get() as { t: string | null };
    if (!next.t || Date.parse(next.t) > end) return;
    h.clock.advance(Math.max(0, Date.parse(next.t) - h.clock.now()) + 1);
  }
}
async function submitted() {
  const id = await paidOrder(h);
  await settle();
  expect(order(id).fulfilment_state).toBe('submitted');
  return id;
}

describe('hold deadlines (07 §2.5, I4)', () => {
  it('a refused order: the draft never existed, so the deadline refunds the whole order, and it completes', async () => {
    h.printful.scenario({ refuseNextOrder: true });
    const id = await paidOrder(h);
    await settle();
    expect(order(id)).toMatchObject({ payment_state: 'refunded', refunded_cents: order(id).paid_cents, completed_at: expect.any(String) });
    expect(refunds(id)).toEqual([{ purpose: 'deadline', state: 'succeeded', amount_cents: order(id).paid_cents }]);
    expect(openHolds(id)).toEqual([]);
    expect(attempts(id)).toEqual(['deleted']);
  });

  it('a cost-guard hold expires after 24 h: the draft is deleted at Printful, then the refund', async () => {
    h.printful.scenario({ costFactor: 10 });
    const id = await paidOrder(h);
    await settle();
    expect(openHolds(id)).toEqual(['attention:["cost_guard"]:refund']);
    expect(pfOf(id)?.status).toBe('draft');
    h.clock.advance(24 * 3_600_000 + 60_000);
    await settle();
    expect(pfOf(id)).toBeUndefined(); // deleted: the proof that nothing was charged
    expect(order(id)).toMatchObject({ payment_state: 'refunded', fulfilment_state: 'canceled', completed_at: expect.any(String) });
  });

  it('an alert hold is repeated daily, never refunds', async () => {
    const id = await submitted();
    db().prepare("INSERT INTO holds (order_id, kind, reasons_json, since, deadline_at, deadline_action) VALUES (?, 'provider', '[\"provider_hold\"]', ?, ?, 'alert')")
      .run(id, new Date(h.clock.now()).toISOString(), new Date(h.clock.now() + 1000).toISOString());
    h.clock.advance(61_000);
    await h.shop.runner.tick();
    expect(openHolds(id)).toEqual(['provider:["provider_hold"]:alert']);
    expect(refunds(id)).toEqual([]);
    const next = (db().prepare('SELECT deadline_at FROM holds WHERE order_id = ?').get(id) as { deadline_at: string }).deadline_at;
    expect(Date.parse(next) - h.clock.now()).toBe(24 * 3_600_000);
  });
});

describe('refunds (05 §7, I7)', () => {
  it('a full refund by Klaus before production cancels the Printful order and completes the order', async () => {
    const id = await submitted();
    requestFullRefund({ orders: db(), clock: h.clock }, id, 'cancel', 'admin@example.com');
    await settle();
    expect(order(id)).toMatchObject({ payment_state: 'refunded', fulfilment_state: 'canceled', completed_at: expect.any(String) });
    expect(pfOf(id)?.status).toBe('canceled');
    expect(attempts(id)).toEqual(['canceled']);
    // Printful's order_canceled for the shop's own cancel opens nothing.
    expect(openHolds(id)).toEqual([]);
  });

  it('a refund requested before the confirm stops the submission (I2, I3) and deletes the draft', async () => {
    const id = await paidOrder(h);
    await h.shop.runner.tick(); // the draft, costs calculating
    requestFullRefund({ orders: db(), clock: h.clock }, id, 'cancel', 'admin@example.com');
    await settle();
    expect(h.printful.requests.filter((r) => /confirmation$/.test(r.path))).toHaveLength(0);
    expect(pfOf(id)).toBeUndefined();
    expect(order(id)).toMatchObject({ payment_state: 'refunded', completed_at: expect.any(String) });
    expect(openHolds(id)).toEqual([]);
  });

  it('a partial refund in the Dashboard is recorded and changes nothing else', async () => {
    const id = await submitted();
    await h.stripe.dashboardRefund(chargeOf(id).id, 500);
    await settle();
    expect(order(id)).toMatchObject({ payment_state: 'partially_refunded', refunded_cents: 500, fulfilment_state: 'submitted', completed_at: null });
    expect(refunds(id)).toEqual([{ purpose: 'dashboard', state: 'succeeded', amount_cents: 500 }]);
    expect(pfOf(id)?.status).toBe('pending');
  });

  it('a failed refund: a refund_failed hold, alert only', async () => {
    const id = await submitted();
    h.stripe.control.failNextRefund = true;
    requestFullRefund({ orders: db(), clock: h.clock }, id, 'cancel', 'admin@example.com');
    await settle();
    expect(refunds(id)[0].state).toBe('failed');
    expect(openHolds(id)).toEqual(['attention:["refund_failed"]:alert']);
    expect(order(id).payment_state).toBe('paid');
  });

  it('refunding twice asks Stripe once', async () => {
    const id = await submitted();
    requestFullRefund({ orders: db(), clock: h.clock }, id, 'cancel', 'a');
    requestFullRefund({ orders: db(), clock: h.clock }, id, 'cancel', 'a');
    await settle();
    expect(h.stripe.requests.filter((r) => r.path === '/v1/refunds')).toHaveLength(1);
  });
});

describe('early fraud warnings and disputes (05 §4, 07 §2.2)', () => {
  it('a warning before the confirm: fraud hold, draft deleted, refunded at once', async () => {
    h.printful.scenario({ costFactor: 10 }); // keeps the order at the draft
    const id = await paidOrder(h);
    await settle();
    await h.stripe.earlyFraudWarning(chargeOf(id).id);
    await settle();
    expect(order(id)).toMatchObject({ dispute_state: 'warning', payment_state: 'refunded', completed_at: expect.any(String) });
    expect(pfOf(id)).toBeUndefined();
    expect(refunds(id)[0].purpose).toBe('fraud');
  });

  it('a warning after the confirm: cancel at Printful, then refund', async () => {
    const id = await submitted();
    await h.stripe.earlyFraudWarning(chargeOf(id).id);
    await settle();
    expect(pfOf(id)?.status).toBe('canceled');
    expect(order(id).payment_state).toBe('refunded');
  });

  it('a warning in production: alert only, no refund', async () => {
    const id = await submitted();
    await h.printful.advance(pfOf(id)!.id, 'inprocess');
    await settle();
    await h.stripe.earlyFraudWarning(chargeOf(id).id);
    await settle();
    expect(openHolds(id)).toEqual(['fraud:["early_fraud_warning"]:alert']);
    expect(refunds(id)).toEqual([]);
  });

  it('a dispute: never a refund; open holds turn to alerts; lost closes it', async () => {
    h.printful.scenario({ costFactor: 10 });
    const id = await paidOrder(h);
    await settle();
    const dp = await h.stripe.dispute(chargeOf(id).id);
    await settle();
    expect(order(id).dispute_state).toBe('open');
    expect(openHolds(id).sort()).toEqual(['attention:["cost_guard"]:alert', 'fraud:["dispute"]:alert']);
    h.clock.advance(48 * 3_600_000);
    await settle();
    expect(refunds(id)).toEqual([]);
    await h.stripe.closeDispute(dp, 'lost');
    await settle();
    expect(order(id).dispute_state).toBe('lost');
    expect(openHolds(id)).toEqual(['attention:["cost_guard"]:alert']);
  });
});
