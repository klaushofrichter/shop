import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileStore } from '../src/images/store';
import { purge } from '../src/orders/purge';
import { paidOrder, startHarness, type Harness } from './helpers/harness';

// docs/design/07 §5–6: reconciliation's forward and reverse passes, and the purge.

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(() => h.close());

const db = () => h.shop.dbs.orders;
const order = (id: string) => db().prepare('SELECT * FROM orders WHERE id = ?').get(id) as Record<string, any>;
async function settle() {
  for (let i = 0; i < 30; i++) {
    if ((await h.shop.runner.tick()) > 1) continue;
    const next = db().prepare("SELECT MIN(run_after) t FROM jobs WHERE state = 'queued' AND kind IN ('order.submit', 'printful.event', 'stripe.event', 'refund.run', 'order.cancel')").get() as { t: string | null };
    if (!next.t || Date.parse(next.t) - h.clock.now() > 10 * 60_000) return;
    h.clock.advance(Math.max(0, Date.parse(next.t) - h.clock.now()) + 1);
  }
}
/** Run reconciliation through its job, as the hourly schedule does. */
async function runReconcile() {
  const since = (db().prepare('SELECT COALESCE(MAX(id), 0) m FROM reconciliation_runs').get() as { m: number }).m;
  db().prepare("DELETE FROM jobs WHERE kind = 'reconcile.now'").run();
  db().prepare("INSERT INTO jobs (kind, key, state, run_after, created_at, updated_at) VALUES ('reconcile.now', 't', 'queued', ?, ?, ?)").run(new Date(h.clock.now()).toISOString(), 'x', 'x');
  await h.shop.runner.tick();
  // The hourly run may have come due too: every run since counts.
  const runs = (db().prepare('SELECT report_json FROM reconciliation_runs WHERE id > ? ORDER BY id').all(since) as Array<{ report_json: string }>).map(
    (r) => JSON.parse(r.report_json) as { repaired: string[]; alarms: string[]; errors: string[] },
  );
  return { repaired: runs.flatMap((r) => r.repaired), alarms: runs.flatMap((r) => r.alarms), errors: runs.flatMap((r) => r.errors) };
}

describe('reconciliation, forward (07 §5)', () => {
  it('a lost checkout webhook: the paid session is applied and the order submitted', async () => {
    h.stripe.control.dropNext = true;
    await paidOrder(h);
    // The webhook was dropped, so the order is still open.
    const o = db().prepare('SELECT id, payment_state FROM orders ORDER BY created_at DESC LIMIT 1').get() as { id: string; payment_state: string };
    expect(o.payment_state).toBe('checkout_open');
    h.clock.advance(61 * 60_000);
    const rep = await runReconcile();
    expect(rep.repaired).toContain(`${o.id}: payment applied`);
    await settle();
    expect(order(o.id)).toMatchObject({ payment_state: 'paid', fulfilment_state: 'submitted' });
  });

  it('a lost Printful webhook: shipped and delivered found by re-fetching; complete', async () => {
    const id = await paidOrder(h);
    await settle();
    const pf = [...h.printful.orders.values()][0];
    // Ship and deliver without webhooks reaching the shop.
    pf.status = 'fulfilled';
    Object.assign(pf.shipments[0], { status: 'shipped', delivery: 'delivered', shippedAt: h.clock.now(), deliveredAt: h.clock.now() });
    await runReconcile();
    expect(order(id).fulfilment_state).toBe('delivered');
    expect(order(id).completed_at).toBeTruthy();
  });

  it('shipped but never confirmed delivered: complete after COMPLETE_AFTER_SHIPPED_DAYS', async () => {
    const id = await paidOrder(h);
    await settle();
    const pf = [...h.printful.orders.values()][0];
    pf.status = 'fulfilled';
    Object.assign(pf.shipments[0], { status: 'shipped', delivery: 'in_transit', shippedAt: h.clock.now() });
    await runReconcile();
    expect(order(id)).toMatchObject({ fulfilment_state: 'shipped', completed_at: null });
    h.clock.advance(46 * 24 * 3_600_000);
    await runReconcile();
    expect(order(id).completed_at).toBeTruthy();
  });

  it('I10: a paid order with nothing in progress gets an attention hold', async () => {
    const id = await paidOrder(h);
    db().prepare("DELETE FROM jobs WHERE kind = 'order.submit'").run();
    db().prepare("UPDATE orders SET fulfilment_state = 'submitting' WHERE id = ?").run(id); // stuck: not `none`, so step 2 doesn't re-queue
    h.clock.advance(31 * 60_000);
    const rep = await runReconcile();
    expect(rep.alarms.join()).toContain('(I10)');
    expect(db().prepare('SELECT reasons_json FROM holds WHERE order_id = ? AND resolved_at IS NULL').get(id)).toEqual({ reasons_json: '["fulfilment_blocked"]' });
  });

  it('a refund made in the Dashboard while the webhook was lost is recorded', async () => {
    const id = await paidOrder(h);
    await settle();
    h.stripe.control.dropNext = true;
    const ch = [...h.stripe.charges.values()][0];
    await h.stripe.dashboardRefund(ch.id, 300);
    await runReconcile();
    expect(order(id)).toMatchObject({ payment_state: 'partially_refunded', refunded_cents: 300 });
  });
});

describe('reconciliation, reverse (review 1 F15)', () => {
  it('a Printful order the shop does not know is an alarm, never a new row', async () => {
    await paidOrder(h);
    await settle();
    const known = [...h.printful.orders.values()][0];
    h.printful.orders.set(160000001, { ...known, id: 160000001, externalId: null, shipments: [] });
    const rep = await runReconcile();
    expect(rep.alarms).toContain('Printful order 160000001 (pending) is not the shop\'s: a reshipment to link, or unexpected');
    expect(db().prepare("SELECT COUNT(*) n FROM provider_orders").get()).toEqual({ n: 1 });
    // The dashboard shows it.
    expect(rep.errors).toEqual([]);
  });

  it('a finished run is what /health/worker looks at', async () => {
    await runReconcile();
    expect(db().prepare("SELECT value_json FROM settings WHERE key = 'reconcile_finished_at'").get()).toBeTruthy();
  });
});

describe('purge (07 §6)', () => {
  it('personal data 180 days after completion; unpaid orders after 7 days; old quotes and payloads', async () => {
    const id = await paidOrder(h);
    await settle();
    db().prepare("UPDATE orders SET completed_at = ? WHERE id = ?").run(new Date(h.clock.now()).toISOString(), id);
    db().prepare("INSERT INTO orders (id, number, payment_state, ship_country, shipping_method, shipping_cents, items_cents, checkout_idempotency_key, created_at, updated_at) VALUES ('zzzzzzzzzzzzzzzzzzzzzzzzzz', '99999', 'closed_unpaid', 'US', 'STANDARD', 0, 0, 'k', ?, ?)")
      .run(new Date(h.clock.now()).toISOString(), new Date(h.clock.now()).toISOString());
    const deps = { orders: db(), catalog: h.shop.dbs.catalog, clock: h.clock, mode: 'mock' as const, log: () => {} };
    const first = await purge(deps);
    expect(first).toMatchObject({ personalData: 0, unpaid: 0 });
    h.clock.advance(181 * 24 * 3_600_000);
    const second = await purge(deps);
    expect(second).toMatchObject({ personalData: 1, unpaid: 1, errors: [] });
    expect(order(id)).toMatchObject({ email: null, ship_name: null, ship_line1: null, ship_zip: null, ship_state: 'TX', ship_country: 'US', purged_at: expect.any(String) });
    expect(order('zzzzzzzzzzzzzzzzzzzzzzzzzz')).toBeUndefined();
    expect(db().prepare('SELECT COUNT(*) n FROM quotes').get()).toEqual({ n: 0 });
  });

  it('live mode: deletes a print file nothing uses; keeps one an offer or a recent order uses', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'shop-purge-'));
    const store = new FileStore(dir);
    const c = h.shop.dbs.catalog;
    const unused = 'a'.repeat(64);
    c.prepare(`INSERT INTO print_files (sha256, render_key, path, width_px, height_px, bytes, created_at) VALUES (?, 'k-unused', ?, 1, 1, 1, 'now')`).run(unused, `/files/${unused}.jpg`);
    writeFileSync(store.pathOf('files', `${unused}.jpg`), 'x');
    const used = 'print-8x10'.padEnd(64, '0');
    const rep = await purge({ orders: db(), catalog: c, clock: h.clock, mode: 'live', store, log: () => {} });
    expect(rep.printFiles).toBe(1);
    expect(existsSync(store.pathOf('files', `${unused}.jpg`))).toBe(false);
    expect(c.prepare('SELECT deleted_at FROM print_files WHERE sha256 = ?').get(unused)).toEqual({ deleted_at: expect.any(String) });
    expect(c.prepare('SELECT deleted_at FROM print_files WHERE sha256 = ?').get(used)).toEqual({ deleted_at: null });
    // A kept original no work points at goes; one that a work uses stays.
    const stale = 'b'.repeat(64);
    writeFileSync(store.pathOf('originals', stale), 'x');
    c.prepare("UPDATE works SET original_sha256 = ? WHERE work_id = 'w1'").run('c'.repeat(64));
    writeFileSync(store.pathOf('originals', 'c'.repeat(64)), 'x');
    const again = await purge({ orders: db(), catalog: c, clock: h.clock, mode: 'live', store, log: () => {} });
    expect(again.originals).toBe(1);
    expect(existsSync(store.pathOf('originals', stale))).toBe(false);
    expect(existsSync(store.pathOf('originals', 'c'.repeat(64)))).toBe(true);
  });
});
