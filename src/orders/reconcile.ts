/**
 * Reconciliation (docs/design/07 §5): hourly and on demand. The forward pass
 * repairs from the shop's own rows; the reverse pass looks at what Printful and
 * Stripe have that the shop doesn't. The sweep never rebuilds rows: anything
 * unexplained is an alarm for Klaus. The report goes to `reconciliation_runs`;
 * a finished run is what `/health/worker` checks.
 */
import { DAY, MINUTE, iso, type Clock } from '../clock';
import { setSetting, transaction, type Db } from '../db';
import { enqueue, type JobRunner } from '../jobs';
import type { StripeClient } from '../payments/stripe';
import type { FulfilmentProvider } from '../providers/types';
import { RECONCILE_FINISHED_KEY } from '../worker-health';
import { syncShipments } from './fulfilment-events';
import { openHold } from './holds';
import { applyPayment, closeUnpaid, type PaymentDeps } from './payment';
import { maybeComplete, runDeadlines, syncPayment, type RefundDeps } from './refunds';
import { adoptProviderOrder, QUIET_PERIOD_MS, type AttemptRow } from './submit';

export interface ReconcileDeps {
  orders: Db;
  clock: Clock;
  stripe: StripeClient;
  provider?: FulfilmentProvider;
  payment: PaymentDeps;
  refunds: RefundDeps;
  completeAfterShippedDays: number;
  log: (line: Record<string, unknown>) => void;
}

export interface ReconcileReport {
  startedAt: string;
  repaired: string[];
  alarms: string[];
  errors: string[];
}


export async function reconcile(d: ReconcileDeps): Promise<ReconcileReport> {
  const rep: ReconcileReport = { startedAt: iso(d.clock), repaired: [], alarms: [], errors: [] };
  const now = d.clock.now();
  const before = (ms: number) => new Date(now - ms).toISOString();
  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      rep.errors.push(`${name}: ${(e as Error).message.slice(0, 200)}`);
    }
  };

  // 1. checkout_open past expiry + 30 min (sessions live 30 min).
  await step('open checkouts', async () => {
    const rows = d.orders.prepare("SELECT id, stripe_session_id, created_at FROM orders WHERE payment_state = 'checkout_open' AND created_at < ?").all(before(60 * MINUTE)) as Array<{ id: string; stripe_session_id: string | null; created_at: string }>;
    for (const o of rows) {
      if (!o.stripe_session_id) {
        // A lost session id (07 §2.1.1): after the 24 h the idempotency key lives, the reverse pass alone can still find a payment.
        if (Date.parse(o.created_at) < now - DAY && closeUnpaid(d.orders, d.clock, o.id, 'reconciliation')) rep.repaired.push(`${o.id}: no session, closed unpaid`);
        continue;
      }
      const s = await d.stripe.getCheckoutSession(o.stripe_session_id);
      if (s.payment_status === 'paid') {
        if ((await applyPayment(d.payment, o.stripe_session_id)) === 'paid') rep.repaired.push(`${o.id}: payment applied`);
      } else if (s.status === 'expired' && closeUnpaid(d.orders, d.clock, o.id, 'reconciliation')) rep.repaired.push(`${o.id}: closed unpaid`);
    }
  });

  // 2. Paid without fail-safes: the payment transaction again (never a submit). Paid, checked, nothing sent, nothing waiting: submit.
  await step('paid orders', async () => {
    const unchecked = d.orders.prepare("SELECT id, stripe_session_id FROM orders WHERE payment_state = 'paid' AND failsafe_checked_at IS NULL AND stripe_session_id IS NOT NULL").all() as Array<{ id: string; stripe_session_id: string }>;
    for (const o of unchecked) {
      await applyPayment(d.payment, o.stripe_session_id);
      rep.repaired.push(`${o.id}: fail-safes checked`);
    }
    const idle = d.orders
      .prepare(
        `SELECT o.id FROM orders o WHERE o.payment_state = 'paid' AND o.failsafe_checked_at IS NOT NULL AND o.fulfilment_state = 'none'
           AND o.completed_at IS NULL AND o.paid_at < ?
           AND NOT EXISTS (SELECT 1 FROM holds h WHERE h.order_id = o.id AND h.resolved_at IS NULL)
           AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r.order_id = o.id AND r.state IN ('requested', 'succeeded') AND r.purpose != 'dashboard')
           AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.kind = 'order.submit' AND j.key = o.id AND j.state IN ('queued', 'running'))`,
      )
      .all(before(15 * MINUTE)) as Array<{ id: string }>;
    for (const o of idle) {
      if (enqueue(d.orders, d.clock, 'order.submit', o.id, { orderId: o.id })) rep.repaired.push(`${o.id}: submit queued`);
    }
  });

  // 3. Incomplete orders with a confirmed attempt: re-fetch and apply (I6); completion after shipping (07 §2.7 rule 2).
  await step('confirmed orders', async () => {
    if (!d.provider) return;
    const rows = d.orders
      .prepare("SELECT p.* FROM provider_orders p JOIN orders o ON o.id = p.order_id WHERE o.completed_at IS NULL AND p.state = 'confirmed' AND p.kind = 'order'")
      .all() as unknown as AttemptRow[];
    for (const a of rows) {
      const po = await d.provider.getOrder(a.provider_order_id!);
      adoptProviderOrder(d.orders, d.clock, a.order_id, a.attempt, po, 'reconciliation');
      await syncShipments({ orders: d.orders, clock: d.clock, provider: d.provider, log: d.log }, { ...a, state: 'confirmed' });
      const o = d.orders.prepare('SELECT fulfilment_state f FROM orders WHERE id = ?').get(a.order_id) as { f: string };
      const last = d.orders.prepare("SELECT MAX(shipped_at) t FROM shipments WHERE order_id = ? AND shipment_status != 'canceled'").get(a.order_id) as { t: string | null };
      if (o.f === 'shipped' && last.t && Date.parse(last.t) < now - d.completeAfterShippedDays * DAY) {
        d.orders.prepare('UPDATE orders SET completed_at = ? WHERE id = ? AND completed_at IS NULL').run(iso(d.clock), a.order_id);
        rep.repaired.push(`${a.order_id}: complete ${d.completeAfterShippedDays} days after shipping`);
      }
    }
  });

  // 4. confirming past the quiet period: the submit job reads it back and confirms again if still a draft (I3).
  await step('confirming', async () => {
    const rows = d.orders.prepare("SELECT order_id FROM provider_orders WHERE state = 'confirming' AND confirm_requested_at < ?").all(before(QUIET_PERIOD_MS)) as Array<{ order_id: string }>;
    for (const r of rows) if (enqueue(d.orders, d.clock, 'order.submit', r.order_id, { orderId: r.order_id })) rep.repaired.push(`${r.order_id}: confirm re-read queued`);
  });

  // 5. Refunds: old `requested` ones re-run; every paid order of the last 90 days re-read at Stripe (fewer than 10 orders a week).
  await step('refunds', async () => {
    const stuck = d.orders.prepare("SELECT id FROM refunds WHERE state = 'requested' AND requested_at < ?").all(before(60 * MINUTE)) as Array<{ id: string }>;
    for (const r of stuck) if (enqueue(d.orders, d.clock, 'refund.run', r.id, { refundId: r.id })) rep.repaired.push(`${r.id}: refund re-run`);
    const paid = d.orders
      .prepare("SELECT id, refunded_cents FROM orders WHERE payment_state IN ('paid', 'partially_refunded') AND paid_at >= ?")
      .all(before(90 * DAY)) as Array<{ id: string; refunded_cents: number }>;
    for (const o of paid) {
      await syncPayment(d.refunds, o.id, 'reconciliation');
      const after = d.orders.prepare('SELECT refunded_cents FROM orders WHERE id = ?').get(o.id) as { refunded_cents: number };
      if (after.refunded_cents !== o.refunded_cents) rep.repaired.push(`${o.id}: refund recorded`);
    }
  });

  // 6. Holds past their deadline.
  await step('deadlines', async () => {
    await runDeadlines(d.refunds);
  });

  // 7. Inbound events not processed after 10 min.
  await step('inbound events', async () => {
    const rows = d.orders.prepare('SELECT provider, event_id FROM inbound_events WHERE processed_at IS NULL AND received_at < ?').all(before(10 * MINUTE)) as Array<{ provider: string; event_id: string }>;
    for (const e of rows) {
      if (enqueue(d.orders, d.clock, `${e.provider}.event`, e.event_id, { eventId: e.event_id })) rep.repaired.push(`${e.provider} event ${e.event_id}: re-run`);
    }
  });

  // 9. I10: a paid, incomplete order must have a job, a hold, a refund in progress or a confirmed attempt.
  await step('I10', async () => {
    const rows = d.orders
      .prepare(
        `SELECT o.id FROM orders o WHERE o.payment_state IN ('paid', 'partially_refunded') AND o.completed_at IS NULL AND o.paid_at < ?
           AND NOT EXISTS (SELECT 1 FROM holds h WHERE h.order_id = o.id AND h.resolved_at IS NULL)
           AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r.order_id = o.id AND r.state = 'requested')
           AND NOT EXISTS (SELECT 1 FROM provider_orders p WHERE p.order_id = o.id AND p.state IN ('confirmed', 'confirming'))
           AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.kind IN ('order.submit', 'refund.run', 'order.cancel', 'order.fraud_retry') AND (j.key = o.id OR j.key LIKE o.id || '-%' OR j.key LIKE o.id || '/%') AND j.state IN ('queued', 'running'))
           AND o.fulfilment_state NOT IN ('test_draft_ok')`,
      )
      .all(before(30 * MINUTE)) as Array<{ id: string }>;
    for (const o of rows) {
      transaction(d.orders, () => openHold(d.orders, d.clock, o.id, ['fulfilment_blocked'], 'reconciliation'));
      rep.alarms.push(`${o.id}: paid and incomplete with nothing in progress (I10)`);
    }
  });

  // Reverse: Printful's recent orders and Stripe's paid sessions of the last 7 days (review 1 F15).
  await step('reverse printful', async () => {
    if (!d.provider) return;
    for (const po of await d.provider.listRecentOrders(100)) {
      const a = po.externalId
        ? (d.orders.prepare("SELECT * FROM provider_orders WHERE provider = 'printful' AND external_id = ?").get(po.externalId) as AttemptRow | undefined)
        : undefined;
      if (!a) {
        rep.alarms.push(`Printful order ${po.id} (${po.status}) is not the shop's: a reshipment to link, or unexpected`);
        continue;
      }
      if (a.state === 'deleted' && po.status !== 'canceled') rep.alarms.push(`Printful order ${po.id} exists, but the shop recorded it as deleted (${a.order_id})`);
      if (a.state === 'canceled' && po.status !== 'canceled') rep.alarms.push(`Printful order ${po.id} is ${po.status}, the shop recorded it as cancelled (${a.order_id})`);
    }
  });
  await step('reverse stripe', async () => {
    const sessions = await d.stripe.listCompletedSessions(Math.floor((now - 7 * DAY) / 1000));
    for (const s of sessions) {
      if (s.payment_status !== 'paid') continue;
      const o = d.orders.prepare('SELECT id, payment_state FROM orders WHERE stripe_session_id = ?').get(s.id) as { id: string; payment_state: string } | undefined;
      if (!o) {
        rep.alarms.push(`Stripe session ${s.id} is paid but the shop has no order for it`);
        continue;
      }
      if (o.payment_state === 'checkout_open' || o.payment_state === 'closed_unpaid') {
        if ((await applyPayment(d.payment, s.id)) === 'paid') rep.repaired.push(`${o.id}: paid session applied (I1)`);
      }
    }
  });

  // Rule 3 for orders whose cancel finished elsewhere.
  for (const o of d.orders.prepare("SELECT id FROM orders WHERE completed_at IS NULL AND (payment_state = 'refunded' OR dispute_state = 'lost')").all() as Array<{ id: string }>) {
    if (maybeComplete(d.orders, d.clock, o.id)) rep.repaired.push(`${o.id}: complete`);
  }

  const finished = iso(d.clock);
  d.orders
    .prepare('INSERT INTO reconciliation_runs (started_at, finished_at, report_json, alarms) VALUES (?, ?, ?, ?)')
    .run(rep.startedAt, finished, JSON.stringify(rep), rep.alarms.length);
  if (!rep.errors.length) setSetting(d.orders, RECONCILE_FINISHED_KEY, finished, finished);
  if (rep.alarms.length) d.log({ level: 'alert', msg: 'reconciliation alarms', alarms: rep.alarms });
  if (rep.errors.length) d.log({ level: 'warn', msg: 'reconciliation incomplete', errors: rep.errors });
  return rep;
}

export function registerReconcileJob(runner: JobRunner, d: ReconcileDeps): void {
  runner.register('reconcile', {
    repeatEveryMs: 60 * MINUTE,
    maxAttempts: 2,
    async run() {
      await reconcile(d);
    },
  });
  // "Run reconciliation now" (08 §3): once, outside the hourly cycle.
  runner.register('reconcile.now', {
    maxAttempts: 1,
    async run() {
      await reconcile(d);
    },
  });
}

export function scheduleReconcile(orders: Db, clock: Clock): void {
  enqueue(orders, clock, 'reconcile', 'hourly', undefined, 5 * MINUTE);
}

