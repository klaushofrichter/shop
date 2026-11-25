/**
 * Applying a payment (docs/design/07 §2.1, 05 §4, review C F1).
 *
 * The Stripe reads come first: the session with its charge, and all line
 * items. Then ONE transaction: `paid` (from checkout_open or closed_unpaid:
 * a paid session always wins, I1), the amounts and fail-safe inputs, every
 * fail-safe and the breaker (06 §8), the hold or the submit job,
 * `failsafe_checked_at` (I11), the cart emptied and detached, and the
 * confirmation e-mail job. SQLite serialises writers, so the breaker count is
 * exact. Running it again changes nothing.
 */
import { DAY, iso, type Clock } from '../clock';
import type { FailSafeLimits } from '../config';
import { getSetting, transaction, type Db } from '../db';
import { queueEmail } from '../email/jobs';
import { enqueue } from '../jobs';
import { chargeOf, type StripeClient } from '../payments/stripe';
import { openHold, recordEvent } from './holds';

export interface PaymentDeps {
  orders: Db;
  clock: Clock;
  stripe: StripeClient;
  limits: FailSafeLimits;
  log: (line: Record<string, unknown>) => void;
}

export type ApplyResult = 'paid' | 'already' | 'not_paid' | 'unknown_order';

interface OrderRow {
  id: string;
  payment_state: string;
  items_cents: number;
  shipping_cents: number;
  email: string | null;
  cart_id: string | null;
  stripe_session_id: string | null;
  failsafe_checked_at: string | null;
  checkout_quote_id: string | null;
}


export async function applyPayment(d: PaymentDeps, sessionId: string): Promise<ApplyResult> {
  const order = d.orders.prepare('SELECT * FROM orders WHERE stripe_session_id = ?').get(sessionId) as OrderRow | undefined;
  if (!order) return 'unknown_order';
  if (order.failsafe_checked_at) return 'already';

  // ---- reads first ----
  const session = await d.stripe.getCheckoutSession(sessionId, true);
  if (session.payment_status !== 'paid') {
    if (session.status === 'expired') closeUnpaid(d.orders, d.clock, order.id, 'stripe');
    return 'not_paid';
  }
  const lines = await d.stripe.listLineItems(sessionId);
  const { paymentIntent: pi, charge } = chargeOf(session);

  // ---- the checks of 05 §4 ----
  const tax = session.total_details?.amount_tax ?? 0;
  const shipSub = session.shipping_cost?.amount_subtotal ?? -1;
  const shipTax = session.shipping_cost?.amount_tax ?? 0;
  const items = d.orders.prepare('SELECT id FROM order_items WHERE order_id = ?').all(order.id) as Array<{ id: string }>;
  const lineTax = new Map(lines.filter((l) => l.orderItemId).map((l) => [l.orderItemId!, l.amount_tax]));
  const mismatches: string[] = [];
  if (session.currency !== 'usd') mismatches.push('currency');
  if (session.amount_subtotal !== order.items_cents) mismatches.push('items');
  if (shipSub !== order.shipping_cents) mismatches.push('shipping');
  if (session.amount_total !== session.amount_subtotal + shipSub + tax) mismatches.push('total');
  if (items.some((i) => !lineTax.has(i.id)) || [...lineTax.values()].reduce((a, b) => a + b, 0) !== tax - shipTax) mismatches.push('line tax');

  const result = transaction(d.orders, (): ApplyResult => {
    const now = iso(d.clock);
    const upd = d.orders
      .prepare(
        `UPDATE orders SET payment_state = 'paid', paid_cents = ?, tax_cents = ?, stripe_payment_intent = ?, card_fingerprint = ?,
           radar_risk_level = ?, paid_at = COALESCE(paid_at, ?), updated_at = ?
         WHERE id = ? AND payment_state IN ('checkout_open', 'closed_unpaid') AND failsafe_checked_at IS NULL`,
      )
      .run(
        session.amount_total, tax, pi?.id ?? null,
        charge?.payment_method_details?.card?.fingerprint ?? null, charge?.outcome?.risk_level ?? null,
        now, now, order.id,
      );
    if (Number(upd.changes) === 0) {
      // Lost the race to another path, or a payment recorded earlier whose checks didn't run (I11): repair.
      const again = d.orders.prepare('SELECT payment_state, failsafe_checked_at FROM orders WHERE id = ?').get(order.id) as { payment_state: string; failsafe_checked_at: string | null };
      if (again.failsafe_checked_at || again.payment_state !== 'paid') return 'already';
    } else {
      recordEvent(d.orders, d.clock, { orderId: order.id, part: 'payment', from: order.payment_state, to: 'paid', cause: 'stripe', causeRef: sessionId, at: now });
    }
    const setTax = d.orders.prepare('UPDATE order_items SET tax_cents = ? WHERE id = ? AND order_id = ?');
    for (const [itemId, t] of lineTax) setTax.run(t, itemId, order.id);

    // ---- the fail-safes, all evaluated (06 §8, review 1 F8) ----
    const reasons: string[] = [];
    if (mismatches.length) {
      openHold(d.orders, d.clock, order.id, ['amount_mismatch'], 'payment');
      d.log({ level: 'alert', msg: 'payment does not match the order', order: order.id, mismatches });
    } else {
      const since = new Date(d.clock.now() - DAY).toISOString();
      if (session.amount_total >= d.limits.approvalOverCents) reasons.push('amount');
      const same = d.orders
        .prepare(
          `SELECT COUNT(*) n, COALESCE(SUM(paid_cents), 0) cents FROM orders
           WHERE id != ? AND payment_state IN ('paid', 'partially_refunded', 'refunded') AND paid_at >= ?
             AND ((email IS NOT NULL AND email = ?) OR (card_fingerprint IS NOT NULL AND card_fingerprint = ?))`,
        )
        .get(order.id, since, order.email, charge?.payment_method_details?.card?.fingerprint ?? null) as { n: number; cents: number };
      if (same.n >= d.limits.repeatOrders || same.cents + session.amount_total > d.limits.repeatOverCents) reasons.push('repeat');
      const risk = charge?.outcome?.risk_level;
      if (risk === 'elevated' || risk === 'highest') reasons.push('risk');
      // The breaker counts paid orders since max(24 h ago, the last reset); the crossing order is held too.
      // It resets itself as orders leave the window; Klaus's Reset restarts the count at once (ADR-0042).
      const reset = getSetting<string>(d.orders, 'breaker_reset_at');
      const from = reset && reset > since ? reset : since;
      const recent = d.orders.prepare(`SELECT COUNT(*) n FROM orders WHERE payment_state IN ('paid', 'partially_refunded', 'refunded') AND paid_at >= ?`).get(from) as { n: number };
      // Its cost half (ADR-0042): Printful's cost of those orders (the confirmed attempt's, else the quote's
      // estimate, which is all this order has yet) above the limit trips it too.
      const cost = d.orders
        .prepare(
          `SELECT COALESCE(SUM(COALESCE(
             (SELECT json_extract(p.costs_json, '$.totalCents') FROM provider_orders p
               WHERE p.order_id = o.id AND p.state IN ('confirmed', 'confirming') ORDER BY p.attempt DESC LIMIT 1),
             (SELECT q.est_cost_cents FROM quotes q WHERE q.id = o.checkout_quote_id),
             0)), 0) AS cents
           FROM orders o WHERE o.payment_state IN ('paid', 'partially_refunded', 'refunded') AND o.paid_at >= ?`,
        )
        .get(from) as { cents: number };
      if (recent.n > d.limits.breakerOrders24h || cost.cents > d.limits.breakerCostCents24h) {
        reasons.push('breaker');
        d.log({ level: 'alert', msg: 'circuit breaker tripped', order: order.id, kind: recent.n > d.limits.breakerOrders24h ? 'orders' : 'cost' });
      }
      if (reasons.length) {
        openHold(d.orders, d.clock, order.id, reasons, 'payment');
        d.log({ level: 'alert', msg: 'order held for approval', order: order.id, reasons });
      } else {
        enqueue(d.orders, d.clock, 'order.submit', order.id, { orderId: order.id });
      }
    }
    d.orders.prepare('UPDATE orders SET failsafe_checked_at = ? WHERE id = ?').run(now, order.id);

    // The cart is emptied and detached on the first paid transition (reviews A F12, B F10).
    if (order.cart_id) {
      // Only if the cart is still the one this order was made from: a customer who came back,
      // changed the cart and then paid the older session keeps what they added (review F8).
      const cart = d.orders.prepare('SELECT open_order_id, quote_id FROM carts WHERE id = ?').get(order.cart_id) as { open_order_id: string | null; quote_id: string | null } | undefined;
      if (cart?.open_order_id === order.id && cart.quote_id !== null && cart.quote_id === order.checkout_quote_id) {
        d.orders.prepare('DELETE FROM cart_items WHERE cart_id = ?').run(order.cart_id);
      }
      d.orders.prepare('UPDATE carts SET open_order_id = NULL, quote_id = NULL, updated_at = ? WHERE id = ? AND open_order_id = ?').run(now, order.cart_id, order.id);
    }
    queueEmail(d.orders, d.clock, order.id, 'confirmation');
    return 'paid';
  });
  if (result === 'paid') d.log({ level: 'info', msg: 'payment applied', order: order.id });
  return result;
}

/** checkout_open → closed_unpaid, only after Stripe says the session is expired (07 §2.1). */
export function closeUnpaid(orders: Db, clock: Clock, orderId: string, cause: string): boolean {
  return transaction(orders, () => {
    const now = iso(clock);
    const r = orders.prepare("UPDATE orders SET payment_state = 'closed_unpaid', updated_at = ? WHERE id = ? AND payment_state = 'checkout_open'").run(now, orderId);
    if (!Number(r.changes)) return false;
    recordEvent(orders, clock, { orderId, part: 'payment', from: 'checkout_open', to: 'closed_unpaid', cause, at: now });
    orders.prepare('UPDATE carts SET open_order_id = NULL WHERE open_order_id = ?').run(orderId);
    return true;
  });
}
