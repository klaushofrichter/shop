/**
 * Refunds, cancellations, hold deadlines, disputes and early fraud warnings
 * (docs/design/05 §4, §7; 06 §6–7; 07 §2.2, §2.5, §2.7; invariants I4, I7).
 *
 * - A refund is a `refunds` row first (`requested`, which blocks any confirm:
 *   I2, I3), then the Stripe call (`refund.run`), then the charge's
 *   `amount_refunded` decides `payment_state`. Only a full refund applies I7
 *   (cancel what is still cancellable) and resolves the open holds.
 * - An **automatic** refund needs proof that nothing is live at Printful for
 *   every attempt (I4): never created, cancelled, or deleted now.
 * - Hold deadlines: `refund` → prove I4, then refund; otherwise the hold turns
 *   into an alert. `alert` → an alert, repeated daily.
 */
import { iso, type Clock } from '../clock';
import { transaction, type Db } from '../db';
import { enqueue, RetryLater, type JobRunner } from '../jobs';
import { chargeOf, StripeError, type Charge, type StripeClient } from '../payments/stripe';
import { ProviderError, type FulfilmentProvider } from '../providers/types';
import { openHold } from './holds';
import { moveFulfilment, newestAttempt, QUIET_PERIOD_MS, type AttemptRow } from './submit';

export interface RefundDeps {
  orders: Db;
  clock: Clock;
  stripe: StripeClient;
  provider?: FulfilmentProvider;
  /** The customer's "delayed" e-mail after a hold this old (09 §1); 0 = never. */
  delayNoticeMs?: number;
  log: (line: Record<string, unknown>) => void;
}

export type RefundPurpose = 'cancel' | 'anyway' | 'deadline' | 'fraud' | 'dashboard';

interface OrderPay {
  id: string;
  payment_state: string;
  dispute_state: string;
  paid_cents: number | null;
  refunded_cents: number;
  stripe_session_id: string | null;
  stripe_payment_intent: string | null;
  completed_at: string | null;
}

const H = 60 * 60_000;
const orderOf = (db: Db, id: string) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as OrderPay | undefined;
const attemptsOf = (db: Db, id: string) =>
  db.prepare("SELECT * FROM provider_orders WHERE order_id = ? AND provider = 'printful' AND kind = 'order' ORDER BY attempt").all(id) as unknown as AttemptRow[];
const event = (db: Db, clock: Clock, orderId: string, part: string, from: string | null, to: string | null, cause: string, note?: string) =>
  db.prepare('INSERT INTO order_events (order_id, part, from_value, to_value, cause, note, at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(orderId, part, from, to, cause, note ?? null, iso(clock));

async function orderCharge(d: RefundDeps, o: OrderPay): Promise<Charge | undefined> {
  if (!o.stripe_session_id) return undefined;
  return chargeOf(await d.stripe.getCheckoutSession(o.stripe_session_id, true)).charge;
}

// ---------------------------------------------------------------- refunds

/**
 * Ask for a full refund of what is left. Idempotent per order: an open or
 * succeeded shop refund is returned as it is. The row blocks confirm at once.
 */
export function requestFullRefund(d: Pick<RefundDeps, 'orders' | 'clock'>, orderId: string, purpose: Exclude<RefundPurpose, 'dashboard'>, by: string): string {
  return transaction(d.orders, () => {
    const open = d.orders.prepare("SELECT id FROM refunds WHERE order_id = ? AND purpose != 'dashboard' AND state IN ('requested', 'succeeded')").get(orderId) as { id: string } | undefined;
    if (open) return open.id;
    const n = (d.orders.prepare('SELECT COUNT(*) n FROM refunds WHERE order_id = ?').get(orderId) as { n: number }).n + 1;
    const o = orderOf(d.orders, orderId)!;
    const id = `${orderId}-r${n}`;
    d.orders
      .prepare("INSERT INTO refunds (id, order_id, purpose, amount_cents, state, requested_at, requested_by) VALUES (?, ?, ?, ?, 'requested', ?, ?)")
      .run(id, orderId, purpose, Math.max(0, (o.paid_cents ?? 0) - o.refunded_cents), iso(d.clock), by);
    event(d.orders, d.clock, orderId, 'refund', null, 'requested', by === 'deadline' || by === 'stripe' ? 'job' : 'admin', purpose);
    enqueue(d.orders, d.clock, 'refund.run', id, { refundId: id });
    return id;
  });
}

function failRefund(d: RefundDeps, refundId: string, orderId: string, error: string, final: boolean) {
  transaction(d.orders, () => {
    const r = d.orders.prepare("UPDATE refunds SET state = 'failed', finished_at = ?, last_error = ? WHERE id = ? AND state = 'requested'").run(iso(d.clock), error.slice(0, 300), refundId);
    if (!Number(r.changes)) return;
    event(d.orders, d.clock, orderId, 'refund', 'requested', 'failed', 'job', error.slice(0, 200));
    // A disputed charge can't be refunded (Stripe settles it); anything else needs Klaus: retry or fulfil anyway.
    if (!final) openHold(d.orders, d.clock, orderId, ['refund_failed'], 'job');
  });
  d.log({ level: 'alert', msg: 'refund failed', order: orderId, error: error.slice(0, 200) });
}

export async function runRefund(d: RefundDeps, refundId: string): Promise<string> {
  const r = d.orders.prepare('SELECT * FROM refunds WHERE id = ?').get(refundId) as { id: string; order_id: string; state: string; stripe_refund_id: string | null } | undefined;
  if (!r || r.state !== 'requested') return 'done';
  const o = orderOf(d.orders, r.order_id)!;
  if (r.stripe_refund_id) {
    // Waiting on a pending refund.
    const sr = await d.stripe.getRefund(r.stripe_refund_id);
    if (sr.status === 'succeeded') return (await syncPayment(d, r.order_id, 'job'), 'succeeded');
    if (sr.status === 'failed' || sr.status === 'canceled') return (failRefund(d, refundId, r.order_id, `refund ${sr.status}`, false), 'failed');
    throw new RetryLater(H, 'refund pending');
  }
  // Read first: what is left to refund (05 §7).
  const charge = await orderCharge(d, o);
  if (!charge || !o.stripe_payment_intent) return (failRefund(d, refundId, r.order_id, 'no charge to refund', false), 'failed');
  const left = charge.amount - charge.amount_refunded;
  if (left <= 0) {
    await syncPayment(d, r.order_id, 'job');
    return 'already refunded';
  }
  try {
    const sr = await d.stripe.createRefund(o.stripe_payment_intent, left, { order_id: r.order_id, refund_id: refundId }, `refund-${refundId}`);
    d.orders.prepare('UPDATE refunds SET stripe_refund_id = ?, amount_cents = ? WHERE id = ?').run(sr.id, left, refundId);
    if (sr.status === 'failed' || sr.status === 'canceled') return (failRefund(d, refundId, r.order_id, `refund ${sr.status}`, false), 'failed');
    if (sr.status !== 'succeeded') throw new RetryLater(H, 'refund pending');
    await syncPayment(d, r.order_id, 'job');
    return 'succeeded';
  } catch (e) {
    if (!(e instanceof StripeError)) throw e;
    if (e.code === 'charge_already_refunded') return (await syncPayment(d, r.order_id, 'job'), 'already refunded');
    if (e.code === 'charge_disputed') return (failRefund(d, refundId, r.order_id, 'the charge is disputed', true), 'disputed');
    if (e.kind === 'permanent' || e.kind === 'idempotency') return (failRefund(d, refundId, r.order_id, e.message, false), 'failed');
    throw e; // unavailable, unknown (the key repeats it safely), rate limited
  }
}

/**
 * The charge's `amount_refunded` decides `payment_state` (07 §2.1). A refund
 * the shop didn't ask for (the Dashboard) gets a `dashboard` row. A **full**
 * refund resolves every open hold and applies I7.
 */
export async function syncPayment(d: RefundDeps, orderId: string, cause: string): Promise<void> {
  const o = orderOf(d.orders, orderId);
  if (!o || !['paid', 'partially_refunded', 'refunded'].includes(o.payment_state)) return;
  const charge = await orderCharge(d, o);
  if (!charge) return;
  const full = charge.amount_refunded >= charge.amount;
  const becameFull = transaction(d.orders, () => {
    const now = iso(d.clock);
    const cur = orderOf(d.orders, orderId)!;
    if (charge.amount_refunded === cur.refunded_cents) return false;
    const to = full ? 'refunded' : charge.amount_refunded > 0 ? 'partially_refunded' : cur.payment_state;
    d.orders.prepare('UPDATE orders SET refunded_cents = ?, payment_state = ?, updated_at = ? WHERE id = ?').run(charge.amount_refunded, to, now, orderId);
    if (to !== cur.payment_state) event(d.orders, d.clock, orderId, 'payment', cur.payment_state, to, cause);
    // Shop refunds that are now covered succeed; any rest was made in the Dashboard.
    const asked = d.orders.prepare("SELECT id, amount_cents FROM refunds WHERE order_id = ? AND state = 'requested' AND purpose != 'dashboard'").all(orderId) as Array<{ id: string; amount_cents: number }>;
    let covered = cur.refunded_cents;
    for (const r of asked) {
      if (charge.amount_refunded - covered >= r.amount_cents || full) {
        d.orders.prepare("UPDATE refunds SET state = 'succeeded', finished_at = ? WHERE id = ?").run(now, r.id);
        event(d.orders, d.clock, orderId, 'refund', 'requested', 'succeeded', cause);
        covered += r.amount_cents;
      }
    }
    const rest = charge.amount_refunded - Math.max(covered, cur.refunded_cents);
    if (rest > 0) {
      const n = (d.orders.prepare('SELECT COUNT(*) n FROM refunds WHERE order_id = ?').get(orderId) as { n: number }).n + 1;
      d.orders
        .prepare("INSERT INTO refunds (id, order_id, purpose, amount_cents, state, requested_at, requested_by, finished_at) VALUES (?, ?, 'dashboard', ?, 'succeeded', ?, 'stripe', ?)")
        .run(`${orderId}-r${n}`, orderId, rest, now, now);
      event(d.orders, d.clock, orderId, 'refund', null, 'succeeded', cause, 'made in the Stripe Dashboard');
    }
    if (!full || cur.payment_state === 'refunded') return false;
    d.orders.prepare("UPDATE holds SET resolved_at = ?, resolved_by = 'refund', resolution = 'refunded' WHERE order_id = ? AND resolved_at IS NULL").run(now, orderId);
    return true;
  });
  if (becameFull) {
    enqueue(d.orders, d.clock, 'email.send', `${orderId}/refunded`, { orderId, kind: 'refunded' });
    const anyway = d.orders.prepare("SELECT 1 FROM refunds WHERE order_id = ? AND purpose = 'anyway'").get(orderId);
    if (!anyway) enqueue(d.orders, d.clock, 'order.cancel', orderId, { orderId });
    else maybeComplete(d.orders, d.clock, orderId);
  }
}

// ---------------------------------------------------------------- cancellation (06 §6, I4, I7)

export type Proof = 'nothing_live' | 'live' | 'wait';

/**
 * Make every attempt provably not live at Printful, as far as allowed:
 * drafts, failed and cancelled orders are deleted (a 204 proves "not charged");
 * a confirmed order is cancelled only when `cancelConfirmed`. Returns whether
 * nothing is live now (I4), something is, or the answer must wait for a
 * confirm's quiet period.
 */
export async function makeNothingLive(d: RefundDeps, orderId: string, cancelConfirmed: boolean): Promise<Proof> {
  if (!d.provider) return attemptsOf(d.orders, orderId).length ? 'wait' : 'nothing_live';
  let result: Proof = 'nothing_live';
  for (const a of attemptsOf(d.orders, orderId)) {
    if (a.state === 'canceled' || a.state === 'deleted') continue;
    if (a.state === 'confirming' && d.clock.now() - Date.parse(a.confirm_requested_at!) < QUIET_PERIOD_MS) {
      result = 'wait';
      continue;
    }
    let po = a.provider_order_id ? await d.provider.getOrder(a.provider_order_id).catch(notFound) : await d.provider.findOrder(a.external_id);
    if (!po) {
      setAttempt(d, a, 'deleted', 'not found at Printful');
      continue;
    }
    if (po.status === 'canceled') {
      setAttempt(d, a, 'canceled', 'canceled at Printful', po.id);
      continue;
    }
    if (po.status === 'draft' || po.status === 'failed') {
      const r = await d.provider.deleteOrder(po.id);
      if (r === 'deleted') {
        setAttempt(d, a, 'deleted', 'draft deleted', po.id);
        continue;
      }
      d.log({ level: 'alert', msg: 'Printful refused to delete the order: it may have been charged', order: orderId, attempt: a.attempt });
      result = result === 'wait' ? 'wait' : 'live';
      continue;
    }
    if (cancelConfirmed && ['pending', 'inreview', 'on_hold'].includes(po.status)) {
      const r = await d.provider.cancel(po.id);
      if (r === 'canceled') {
        setAttempt(d, a, 'canceled', 'canceled by the shop', po.id);
        continue;
      }
    }
    result = result === 'wait' ? 'wait' : 'live';
  }
  return result;
}

function notFound(e: unknown): null {
  if (e instanceof ProviderError && e.status === 404) return null;
  throw e;
}

function setAttempt(d: RefundDeps, a: AttemptRow, state: 'canceled' | 'deleted', note: string, providerOrderId?: string) {
  transaction(d.orders, () => {
    const now = iso(d.clock);
    d.orders
      .prepare("UPDATE provider_orders SET state = ?, provider_order_id = COALESCE(provider_order_id, ?), updated_at = ? WHERE order_id = ? AND provider = 'printful' AND attempt = ?")
      .run(state, providerOrderId ?? null, now, a.order_id, a.attempt);
    if (newestAttempt(d.orders, a.order_id)?.attempt === a.attempt) moveFulfilment(d.orders, d.clock, a.order_id, 'canceled', 'job', a.attempt, note);
  });
}

/** Completion rules 3 and 6 (07 §2.7): refunded or a lost dispute, with nothing live at Printful. */
export function maybeComplete(db: Db, clock: Clock, orderId: string): boolean {
  const o = orderOf(db, orderId);
  if (!o || o.completed_at) return false;
  const done = o.payment_state === 'refunded' || o.dispute_state === 'lost';
  if (!done) return false;
  if (attemptsOf(db, orderId).some((a) => a.state !== 'canceled' && a.state !== 'deleted')) return false;
  db.prepare('UPDATE orders SET completed_at = ? WHERE id = ? AND completed_at IS NULL').run(iso(clock), orderId);
  return true;
}

/** I7 after a full refund: cancel what is still cancellable, else tell Klaus. */
export async function cancelAfterRefund(d: RefundDeps, orderId: string): Promise<string> {
  const proof = await makeNothingLive(d, orderId, true);
  if (proof === 'wait') throw new RetryLater(QUIET_PERIOD_MS, 'confirm answer pending');
  if (proof === 'live') {
    d.log({ level: 'alert', msg: 'refunded, but the order is already in production at Printful', order: orderId });
    return 'not cancellable';
  }
  maybeComplete(d.orders, d.clock, orderId);
  return 'nothing live';
}

// ---------------------------------------------------------------- hold deadlines (07 §2.5)

interface HoldRow {
  id: number;
  order_id: string;
  kind: string;
  reasons_json: string;
  since: string;
  deadline_at: string;
  deadline_action: 'refund' | 'alert';
}

export async function runDeadlines(d: RefundDeps): Promise<number> {
  // A reminder to Klaus 24 h before a deadline that refunds (09 §2); once per hold.
  const soon = d.orders
    .prepare("SELECT id, order_id, reasons_json FROM holds WHERE resolved_at IS NULL AND deadline_action = 'refund' AND deadline_at > ? AND deadline_at <= ?")
    .all(iso(d.clock), iso(d.clock, 24 * H)) as Array<{ id: number; order_id: string; reasons_json: string }>;
  for (const h of soon) d.log({ level: 'alert', msg: 'hold refunds automatically within 24 h', order: h.order_id, reasons: JSON.parse(h.reasons_json), alertKey: `hold-${h.id}-reminder` });
  // "Delayed" to the customer: a hold older than DELAY_NOTICE_HOURS, only before the first shipment (09 §1); once per order.
  if (d.delayNoticeMs) {
    const late = d.orders
      .prepare(
        `SELECT DISTINCT h.order_id FROM holds h JOIN orders o ON o.id = h.order_id
         WHERE h.resolved_at IS NULL AND h.since <= ? AND o.payment_state IN ('paid', 'partially_refunded') AND o.completed_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM shipments s WHERE s.order_id = o.id)
           AND NOT EXISTS (SELECT 1 FROM emails e WHERE e.order_id = o.id AND e.kind = 'delayed')`,
      )
      .all(iso(d.clock, -d.delayNoticeMs)) as Array<{ order_id: string }>;
    for (const r of late) enqueue(d.orders, d.clock, 'email.send', `${r.order_id}/delayed`, { orderId: r.order_id, kind: 'delayed' });
  }
  const due = d.orders.prepare('SELECT * FROM holds WHERE resolved_at IS NULL AND deadline_at <= ? ORDER BY deadline_at').all(iso(d.clock)) as unknown as HoldRow[];
  for (const h of due) {
    const reasons = JSON.parse(h.reasons_json) as string[];
    if (h.deadline_action === 'alert') {
      // Repeated daily; a failed refund's next reminder comes twice as late (07 §2.5).
      const last = Date.parse(h.deadline_at) - Date.parse(h.since);
      const next = reasons.includes('refund_failed') ? Math.max(2 * last, 24 * H) : 24 * H;
      d.orders.prepare('UPDATE holds SET deadline_at = ? WHERE id = ? AND resolved_at IS NULL').run(iso(d.clock, next), h.id);
      d.log({ level: 'alert', msg: 'hold needs Klaus', order: h.order_id, kind: h.kind, reasons });
      continue;
    }
    const o = orderOf(d.orders, h.order_id)!;
    // I4: never while a dispute is open or lost; and only with proof that nothing is live at Printful.
    const proof = o.dispute_state === 'open' || o.dispute_state === 'lost' ? 'live' : await makeNothingLive(d, h.order_id, false);
    if (proof === 'wait') continue;
    if (proof === 'live') {
      d.orders.prepare("UPDATE holds SET deadline_action = 'alert', deadline_at = ? WHERE id = ? AND resolved_at IS NULL").run(iso(d.clock, 24 * H), h.id);
      d.log({ level: 'alert', msg: 'hold deadline: no automatic refund, something may be live at Printful', order: h.order_id, reasons });
      continue;
    }
    // Only the winner of the conditional update acts (Klaus's Approve can't also proceed).
    const won = d.orders
      .prepare("UPDATE holds SET resolved_at = ?, resolved_by = 'deadline', resolution = 'expired' WHERE id = ? AND resolved_at IS NULL")
      .run(iso(d.clock), h.id);
    if (!Number(won.changes)) continue;
    requestFullRefund(d, h.order_id, 'deadline', 'deadline');
    d.log({ level: 'info', msg: 'hold expired: refunding', order: h.order_id, reasons });
  }
  return due.length;
}

// ---------------------------------------------------------------- disputes and fraud warnings (05 §4, 07 §2.2)

const orderByCharge = async (d: RefundDeps, chargeId: string) => {
  const ch = await d.stripe.getCharge(chargeId);
  if (!ch.payment_intent) return undefined;
  return d.orders.prepare('SELECT * FROM orders WHERE stripe_payment_intent = ?').get(ch.payment_intent) as OrderPay | undefined;
};

const confirmedAttempt = (db: Db, orderId: string) => attemptsOf(db, orderId).some((a) => a.state === 'confirmed' || a.state === 'confirming');

export async function onEarlyFraudWarning(d: RefundDeps, efwId: string): Promise<string> {
  const w = await d.stripe.getEarlyFraudWarning(efwId);
  const o = await orderByCharge(d, w.charge);
  if (!o) return 'unknown charge';
  const before = transaction(d.orders, () => {
    const cur = orderOf(d.orders, o.id)!;
    if (cur.dispute_state === 'none') {
      d.orders.prepare("UPDATE orders SET dispute_state = 'warning', updated_at = ? WHERE id = ?").run(iso(d.clock), o.id);
      event(d.orders, d.clock, o.id, 'dispute', 'none', 'warning', 'stripe_webhook');
    }
    const open = d.orders.prepare("SELECT 1 FROM holds WHERE order_id = ? AND kind = 'fraud' AND resolved_at IS NULL").get(o.id);
    if (!open) openHold(d.orders, d.clock, o.id, ['early_fraud_warning'], 'stripe_webhook');
    return cur.dispute_state;
  });
  if (before === 'open' || before === 'lost') return 'disputed already';
  d.log({ level: 'alert', msg: 'early fraud warning', order: o.id });
  // Not yet confirmed: delete the draft and refund at once. Confirmed: cancel if possible, then refund. Otherwise alert.
  const proof = await makeNothingLive(d, o.id, true);
  if (proof === 'nothing_live') {
    d.orders.prepare("UPDATE holds SET resolved_at = ?, resolved_by = 'fraud', resolution = 'refunded' WHERE order_id = ? AND kind = 'fraud' AND resolved_at IS NULL").run(iso(d.clock), o.id);
    requestFullRefund(d, o.id, 'fraud', 'stripe');
    return 'refunding';
  }
  d.orders.prepare("UPDATE holds SET deadline_action = 'alert' WHERE order_id = ? AND kind = 'fraud' AND resolved_at IS NULL").run(o.id);
  if (proof === 'wait') enqueue(d.orders, d.clock, 'order.fraud_retry', `${o.id}/${efwId}`, { efwId }, QUIET_PERIOD_MS);
  return proof === 'wait' ? 'waiting for a confirm answer' : 'in production: alert';
}

export async function onDispute(d: RefundDeps, disputeId: string, closed: boolean): Promise<string> {
  const dp = await d.stripe.getDispute(disputeId);
  const o = await orderByCharge(d, dp.charge);
  if (!o) return 'unknown charge';
  if (!closed) {
    transaction(d.orders, () => {
      const cur = orderOf(d.orders, o.id)!;
      if (cur.dispute_state !== 'open') {
        d.orders.prepare("UPDATE orders SET dispute_state = 'open', updated_at = ? WHERE id = ?").run(iso(d.clock), o.id);
        event(d.orders, d.clock, o.id, 'dispute', cur.dispute_state, 'open', 'stripe_webhook');
      }
      // Never a refund while disputed: open fraud holds turn into alerts.
      d.orders.prepare("UPDATE holds SET deadline_action = 'alert' WHERE order_id = ? AND resolved_at IS NULL").run(o.id);
      const open = d.orders.prepare("SELECT 1 FROM holds WHERE order_id = ? AND kind = 'fraud' AND resolved_at IS NULL").get(o.id);
      if (!open) openHold(d.orders, d.clock, o.id, ['dispute'], 'stripe_webhook');
    });
    if (confirmedAttempt(d.orders, o.id)) await makeNothingLive(d, o.id, true);
    d.log({ level: 'alert', msg: 'dispute opened', order: o.id });
    return 'dispute open';
  }
  const outcome = dp.status === 'won' ? 'won' : dp.status === 'lost' ? 'lost' : undefined;
  if (!outcome) return `dispute ${dp.status}`;
  transaction(d.orders, () => {
    const cur = orderOf(d.orders, o.id)!;
    if (cur.dispute_state !== outcome) {
      d.orders.prepare('UPDATE orders SET dispute_state = ?, updated_at = ? WHERE id = ?').run(outcome, iso(d.clock), o.id);
      event(d.orders, d.clock, o.id, 'dispute', cur.dispute_state, outcome, 'stripe_webhook');
    }
    if (outcome === 'lost') {
      d.orders.prepare("UPDATE holds SET resolved_at = ?, resolved_by = 'stripe', resolution = 'cleared' WHERE order_id = ? AND kind = 'fraud' AND resolved_at IS NULL").run(iso(d.clock), o.id);
      maybeComplete(d.orders, d.clock, o.id);
    }
    // Won: the fraud hold stays open for Klaus to decide on fulfilment (07 §2.2).
  });
  d.log({ level: 'alert', msg: `dispute ${outcome}`, order: o.id });
  return `dispute ${outcome}`;
}

// ---------------------------------------------------------------- jobs

export function registerRefundJobs(runner: JobRunner, d: RefundDeps): void {
  runner.register('refund.run', {
    maxAttempts: 50,
    async run(ctx) {
      await runRefund(d, (ctx.payload as { refundId: string }).refundId);
    },
  });
  runner.register('order.cancel', {
    maxAttempts: 50,
    async run(ctx) {
      await cancelAfterRefund(d, (ctx.payload as { orderId: string }).orderId);
    },
  });
  runner.register('order.fraud_retry', {
    maxAttempts: 20,
    async run(ctx) {
      await onEarlyFraudWarning(d, (ctx.payload as { efwId: string }).efwId);
    },
  });
  runner.register('holds.deadlines', {
    repeatEveryMs: 60_000,
    maxAttempts: 3,
    async run() {
      await runDeadlines(d);
    },
  });
}

/** Start the deadline sweep (a no-op if one is queued). */
export function scheduleDeadlines(orders: Db, clock: Clock): void {
  enqueue(orders, clock, 'holds.deadlines', 'all');
}

/** The Stripe events of step 7, dispatched from `stripe.event` (05 §4). */
export async function onStripeEvent(d: RefundDeps, type: string, objectId: string): Promise<string | undefined> {
  switch (type) {
    case 'charge.refunded': {
      const o = await orderByCharge(d, objectId);
      if (!o) return 'unknown charge';
      await syncPayment(d, o.id, 'stripe_webhook');
      return 'refund synced';
    }
    case 'refund.updated':
    case 'refund.failed': {
      const r = await d.stripe.getRefund(objectId);
      const row = d.orders.prepare('SELECT id, order_id FROM refunds WHERE stripe_refund_id = ?').get(r.id) as { id: string; order_id: string } | undefined;
      if (r.status === 'failed' || r.status === 'canceled') {
        if (row) failRefund(d, row.id, row.order_id, `refund ${r.status}`, false);
        else d.log({ level: 'alert', msg: 'a refund the shop did not make failed', refund: r.id });
        return 'refund failed';
      }
      const o = row ? orderOf(d.orders, row.order_id) : await orderByCharge(d, r.charge);
      if (o) await syncPayment(d, o.id, 'stripe_webhook');
      return `refund ${r.status}`;
    }
    case 'radar.early_fraud_warning.created':
      return onEarlyFraudWarning(d, objectId);
    case 'charge.dispute.created':
      return onDispute(d, objectId, false);
    case 'charge.dispute.closed':
      return onDispute(d, objectId, true);
    default:
      return undefined;
  }
}

