/**
 * Submission to Printful (docs/design/06 §4, 07 §2.3–2.4, invariants I2, I3,
 * I5, I11). Job `order.submit`, enqueued by the payment transaction; every
 * step is re-entrant, so a crash or a lost answer anywhere is repaired by the
 * next run:
 *
 *   1. preconditions (I2), else an `attention` hold (I10);
 *   2. claim attempt N (one row per attempt, external id `<order>-<N>`);
 *   3. look the attempt up by external id: adopt what exists;
 *   4. create the draft (`unknown` → the next run looks up first);
 *   5. wait for Printful's costs;
 *   6. the cost guard;
 *   7. test mode stops here (`test_draft_ok`);
 *   8. confirm: a fresh read of the charge's refunds, then one transaction that
 *      re-checks I2 and writes `confirm_requested_at` (I3), then the call. A
 *      lost answer is read back after the quiet period; a draft is confirmed
 *      again, at most three times.
 */
import type { SkuCatalog } from '../catalog-config';
import { iso, type Clock } from '../clock';
import type { Config, Mode, QuoteSettings } from '../config';
import { transaction, type Db } from '../db';
import { RetryLater, type JobRunner } from '../jobs';
import { chargeOf, type StripeClient } from '../payments/stripe';
import { placementFor } from '../providers/checks';
import { ProviderError, type DraftOrder, type FulfilmentProvider, type ProviderOrder, type ProviderOrderStatus } from '../providers/types';
import { openHold } from './holds';

export interface SubmitDeps {
  orders: Db;
  catalog: Db;
  clock: Clock;
  provider: FulfilmentProvider;
  stripe: StripeClient;
  mode: Mode;
  publicUrl: string;
  skus: SkuCatalog;
  quote: QuoteSettings;
  fulfilment: Config['fulfilment'];
  log: (line: Record<string, unknown>) => void;
}

/** Confirm timeout (the adapter's 15 s) + 2 min (07 §2.8 I4). */
export const QUIET_PERIOD_MS = 15_000 + 2 * 60_000;
export const MAX_CONFIRM_TRIES = 3;
const COSTS_POLL_MS = 5_000;

export interface OrderRow {
  id: string;
  number: string;
  payment_state: string;
  fulfilment_state: string;
  dispute_state: string;
  failsafe_checked_at: string | null;
  ship_name: string;
  ship_line1: string;
  ship_line2: string | null;
  ship_city: string;
  ship_state: string;
  ship_zip: string;
  ship_country: string;
  shipping_method: string;
  shipping_cents: number;
  items_cents: number;
  tax_cents: number | null;
  paid_cents: number | null;
  refunded_cents: number;
  stripe_session_id: string | null;
  paid_at: string | null;
  completed_at: string | null;
}

export interface AttemptRow {
  order_id: string;
  attempt: number;
  external_id: string;
  provider_order_id: string | null;
  state: 'submitting' | 'draft' | 'confirming' | 'confirmed' | 'canceled' | 'deleted' | 'failed';
  confirm_requested_at: string | null;
  confirm_tries: number;
  override_at: string | null;
  updated_at: string;
}

/** Provider status → the order's `fulfilment_state` (07 §2.3). */
export const FULFILMENT_OF: Record<ProviderOrderStatus, string> = {
  draft: 'draft',
  pending: 'submitted',
  inreview: 'submitted',
  on_hold: 'on_hold',
  in_production: 'in_production',
  partially_shipped: 'partially_shipped',
  fulfilled: 'shipped',
  canceled: 'canceled',
  failed: 'failed',
};

const CONFIRMED: ProviderOrderStatus[] = ['pending', 'inreview', 'on_hold', 'in_production', 'partially_shipped', 'fulfilled'];

const getOrder = (db: Db, id: string) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as OrderRow | undefined;
export const newestAttempt = (db: Db, orderId: string) =>
  db.prepare("SELECT * FROM provider_orders WHERE order_id = ? AND provider = 'printful' AND kind = 'order' ORDER BY attempt DESC LIMIT 1").get(orderId) as AttemptRow | undefined;
const openHoldCount = (db: Db, orderId: string) => (db.prepare('SELECT COUNT(*) n FROM holds WHERE order_id = ? AND resolved_at IS NULL').get(orderId) as { n: number }).n;

/** I2, read inside the caller's transaction. Returns what fails, empty when it holds. */
export function i2Failures(db: Db, orderId: string): string[] {
  const o = getOrder(db, orderId);
  if (!o) return ['no order'];
  const out: string[] = [];
  if (o.payment_state !== 'paid' && o.payment_state !== 'partially_refunded') out.push(`payment ${o.payment_state}`);
  if (!o.failsafe_checked_at) out.push('fail-safes not checked');
  if (openHoldCount(db, orderId) > 0) out.push('open hold');
  const refund = db.prepare("SELECT COUNT(*) n FROM refunds WHERE order_id = ? AND state IN ('requested', 'succeeded') AND purpose != 'dashboard'").get(orderId) as { n: number };
  if (refund.n > 0) out.push('refund issued');
  if (o.dispute_state !== 'none' && o.dispute_state !== 'won') out.push(`dispute ${o.dispute_state}`);
  return out;
}

/** A conditional move of `fulfilment_state` with its event (07 §2.10). False when another path moved it first. */
export function moveFulfilment(db: Db, clock: Clock, orderId: string, to: string, cause: string, attempt: number | null, note?: string): boolean {
  const o = getOrder(db, orderId);
  if (!o || o.fulfilment_state === to) return false;
  const now = iso(clock);
  const r = db.prepare('UPDATE orders SET fulfilment_state = ?, updated_at = ? WHERE id = ? AND fulfilment_state = ?').run(to, now, orderId, o.fulfilment_state);
  if (!Number(r.changes)) return false;
  db.prepare("INSERT INTO order_events (order_id, part, attempt, from_value, to_value, cause, note, at) VALUES (?, 'fulfilment', ?, ?, ?, ?, ?, ?)").run(
    orderId, attempt, o.fulfilment_state, to, cause, note ?? null, now,
  );
  return true;
}

/** Record what the provider says about an attempt; only the newest attempt moves the order (07 §2.4). */
export function adoptProviderOrder(db: Db, clock: Clock, orderId: string, attempt: number, po: ProviderOrder, cause: string): void {
  transaction(db, () => {
    const now = iso(clock);
    const a = db.prepare("SELECT * FROM provider_orders WHERE order_id = ? AND provider = 'printful' AND attempt = ?").get(orderId, attempt) as unknown as AttemptRow;
    let state = a.state;
    if (CONFIRMED.includes(po.status)) state = 'confirmed';
    else if (po.status === 'canceled') state = 'canceled';
    else if (po.status === 'failed') state = 'failed';
    else if (po.status === 'draft' && (a.state === 'submitting' || a.state === 'draft')) state = 'draft';
    db.prepare(
      "UPDATE provider_orders SET provider_order_id = ?, status = ?, state = ?, costs_json = ?, updated_at = ? WHERE order_id = ? AND provider = 'printful' AND attempt = ?",
    ).run(po.id, po.status, state, JSON.stringify(po.costs), now, orderId, attempt);
    if (newestAttempt(db, orderId)?.attempt !== attempt) return;
    const to = po.status === 'draft' && a.state === 'confirming' ? 'confirming' : FULFILMENT_OF[po.status];
    // Delivery is the shop's own conclusion from the shipments; Printful's `fulfilled` never undoes it.
    const cur = (db.prepare('SELECT fulfilment_state f FROM orders WHERE id = ?').get(orderId) as { f: string }).f;
    if ((cur === 'delivered' && to === 'shipped') || cur === 'test_draft_ok') return;
    moveFulfilment(db, clock, orderId, to, cause, attempt);
  });
}

function blocked(d: SubmitDeps, orderId: string, why: string[]): void {
  // A refund the shop asked for, or a refunded order, is a stop, not a problem for Klaus.
  if (why.every((w) => w === 'refund issued' || w === 'payment refunded' || w === 'open hold')) return;
  transaction(d.orders, () => {
    if (openHoldCount(d.orders, orderId) === 0) {
      openHold(d.orders, d.clock, orderId, ['fulfilment_blocked'], 'job');
      d.log({ level: 'alert', msg: 'submission blocked', order: orderId, why });
    }
  });
}

function hold(d: SubmitDeps, orderId: string, reason: string, msg: string, extra: Record<string, unknown> = {}): void {
  transaction(d.orders, () => {
    if (openHoldCount(d.orders, orderId) === 0) openHold(d.orders, d.clock, orderId, [reason], 'job');
  });
  d.log({ level: 'alert', msg, order: orderId, ...extra });
}

/** The draft for attempt N, built from the frozen order (06 §3, ADR-0031: no customer e-mail or phone). */
export function draftFor(d: SubmitDeps, o: OrderRow, externalId: string): DraftOrder {
  const items = d.orders.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(o.id) as Array<{
    id: string; sku_id: string; name: string; provider_variant_id: number; unit_cents: number; quantity: number; print_file_sha: string; orientation: string | null;
  }>;
  return {
    externalId,
    shipping: o.shipping_method,
    recipient: {
      name: o.ship_name, address1: o.ship_line1, ...(o.ship_line2 ? { address2: o.ship_line2 } : {}),
      city: o.ship_city, stateCode: o.ship_state, zip: o.ship_zip, countryCode: o.ship_country,
    },
    items: items.map((i) => {
      const sku = d.skus.byId.get(i.sku_id);
      if (!sku) throw new Error(`order ${o.id}: unknown SKU ${i.sku_id}`);
      const pf = d.catalog.prepare('SELECT path FROM print_files WHERE sha256 = ?').get(i.print_file_sha) as { path: string } | undefined;
      if (!pf) throw new Error(`order ${o.id}: print file missing`);
      return {
        externalId: i.id,
        variantId: i.provider_variant_id,
        quantity: i.quantity,
        retailCents: i.unit_cents,
        name: i.name,
        ...(sku.kind === 'paper' && i.orientation ? { orientation: i.orientation === 'landscape' ? ('horizontal' as const) : ('vertical' as const) } : {}),
        ...placementFor(sku),
        fileUrl: `${d.publicUrl}${pf.path}`,
      };
    }),
    retail: { shippingCents: o.shipping_cents, taxCents: o.tax_cents ?? 0 },
    packingSlip: { storeName: d.fulfilment.shopName, email: d.fulfilment.packingSlipEmail, phone: d.fulfilment.packingSlipPhone, customOrderId: o.number },
  };
}

/** Provider cost ≤ items + shipping paid − Stripe's fee − the margin floor (06 §4 step 6). Customer tax is never revenue. */
export function costGuard(o: OrderRow, providerTotalCents: number, q: QuoteSettings): { ok: boolean; allowedCents: number } {
  const fee = Math.ceil(((o.paid_cents ?? o.items_cents + o.shipping_cents) * q.stripeFeePct) / 100) + q.stripeFeeFixedCents;
  const allowed = o.items_cents + o.shipping_cents - fee - q.marginFloorCents;
  return { ok: providerTotalCents <= allowed, allowedCents: allowed };
}

export type SubmitOutcome =
  | 'not_needed'
  | 'blocked'
  | 'held'
  | 'test_draft_ok'
  | 'submitted'
  | 'waiting';

export async function submitOrder(d: SubmitDeps, orderId: string): Promise<SubmitOutcome> {
  const o = getOrder(d.orders, orderId);
  if (!o || o.completed_at) return 'not_needed';
  let a = newestAttempt(d.orders, orderId);
  if (a && ['confirmed', 'canceled', 'deleted', 'failed'].includes(a.state)) return 'not_needed';

  // ---- 1. preconditions; 2. claim attempt 1 (N+1 is the admin's, 07 §2.4) ----
  if (!a) {
    const claimed = transaction(d.orders, () => {
      const why = i2Failures(d.orders, orderId);
      if (why.length) return why;
      if (newestAttempt(d.orders, orderId)) return [];
      const now = iso(d.clock);
      d.orders
        .prepare("INSERT INTO provider_orders (order_id, provider, attempt, external_id, state, updated_at) VALUES (?, 'printful', 1, ?, 'submitting', ?)")
        .run(orderId, `${orderId}-1`, now);
      moveFulfilment(d.orders, d.clock, orderId, 'submitting', 'job', 1);
      return [];
    });
    if (claimed.length) {
      blocked(d, orderId, claimed);
      return 'blocked';
    }
    a = newestAttempt(d.orders, orderId)!;
  } else if (a.state === 'submitting' || a.state === 'draft') {
    const why = i2Failures(d.orders, orderId);
    if (why.length) {
      blocked(d, orderId, why);
      return 'blocked';
    }
  }

  try {
    // ---- 3. look up; 4. create ----
    let po: ProviderOrder | null = null;
    if (a.provider_order_id) po = await d.provider.getOrder(a.provider_order_id);
    else {
      po = await d.provider.findOrder(a.external_id);
      if (!po) {
        try {
          po = await d.provider.createDraft(draftFor(d, o, a.external_id));
        } catch (e) {
          if (e instanceof ProviderError && e.kind === 'already_exists') po = await d.provider.findOrder(a.external_id);
          else if (e instanceof ProviderError && e.kind === 'permanent') {
            d.orders.prepare("UPDATE provider_orders SET last_error = ?, updated_at = ? WHERE order_id = ? AND attempt = ?").run(e.message.slice(0, 300), iso(d.clock), orderId, a.attempt);
            hold(d, orderId, 'provider_refused', 'Printful refused the order; it will be refunded', { error: e.message.slice(0, 200) });
            return 'held';
          } else throw e;
        }
        if (!po) throw new RetryLater(30_000, 'created but not found yet');
      }
    }
    adoptProviderOrder(d.orders, d.clock, orderId, a.attempt, po, 'job');
    a = newestAttempt(d.orders, orderId)!;
    if (a.state === 'confirmed') return 'submitted';
    if (a.state !== 'draft' && a.state !== 'confirming') return 'not_needed';

    // ---- 5. costs ----
    if (po.costs.status === 'calculating') throw new RetryLater(COSTS_POLL_MS, 'costs calculating');
    if (po.costs.status === 'failed') {
      hold(d, orderId, 'costs_failed', 'Printful could not calculate the costs');
      return 'held';
    }

    // ---- 6. cost guard (skipped for an attempt Klaus confirmed anyway) ----
    if (!a.override_at) {
      const guard = costGuard(o, po.costs.totalCents ?? Infinity, d.quote);
      if (!guard.ok) {
        hold(d, orderId, 'cost_guard', 'Printful costs more than the order allows', { cost: po.costs.totalCents, allowed: guard.allowedCents });
        return 'held';
      }
    }

    // ---- 7. test mode stops at the draft (07 §2.9) ----
    if (d.mode === 'test' || !d.provider.confirm) {
      transaction(d.orders, () => {
        if (moveFulfilment(d.orders, d.clock, orderId, 'test_draft_ok', 'job', a!.attempt)) {
          d.orders.prepare('UPDATE orders SET completed_at = ? WHERE id = ? AND completed_at IS NULL').run(iso(d.clock), orderId);
        }
      });
      return 'test_draft_ok';
    }

    // ---- 8. confirm (I3) ----
    return await confirmAttempt(d, o, a, po);
  } catch (e) {
    if (e instanceof RetryLater) throw e;
    if (e instanceof ProviderError) {
      if (e.kind === 'rate_limited') throw new RetryLater(e.retryAfterMs ?? 60_000, 'rate limited');
      if (e.kind === 'auth') throw e;
      // unavailable / unknown: retry with backoff until the window closes, then a hold whose deadline refunds only if I4 holds.
      const since = Date.parse(a.updated_at);
      if (d.clock.now() - since > d.fulfilment.providerRetryWindowMs && a.state === 'submitting') {
        hold(d, orderId, 'provider_unavailable', 'Printful unavailable past the retry window', { error: e.message.slice(0, 200) });
        return 'held';
      }
    }
    throw e;
  }
}

async function confirmAttempt(d: SubmitDeps, o: OrderRow, a: AttemptRow, po: ProviderOrder): Promise<SubmitOutcome> {
  if (a.state === 'confirming') {
    // An answer was lost: read back after the quiet period (I3, I4).
    const waited = d.clock.now() - Date.parse(a.confirm_requested_at!);
    if (waited < QUIET_PERIOD_MS) throw new RetryLater(QUIET_PERIOD_MS - waited, 'confirm answer pending');
    if (a.confirm_tries >= MAX_CONFIRM_TRIES) {
      hold(d, o.id, 'confirm_failed', 'Printful did not confirm the order after three tries');
      return 'held';
    }
  }
  // A fresh read of the refunds at Stripe (06 §4 step 8, review A F13).
  const session = await d.stripe.getCheckoutSession(o.stripe_session_id!, true);
  const { charge } = chargeOf(session);
  if (!charge || charge.amount_refunded > 0) {
    blocked(d, o.id, [charge ? 'refunded at Stripe' : 'no charge']);
    return 'blocked';
  }
  const go = transaction(d.orders, () => {
    const why = i2Failures(d.orders, o.id);
    if (why.length) return why;
    const now = iso(d.clock);
    const r = d.orders
      .prepare(
        `UPDATE provider_orders SET state = 'confirming', confirm_requested_at = ?, confirm_tries = confirm_tries + 1, updated_at = ?
         WHERE order_id = ? AND provider = 'printful' AND attempt = ? AND state = ? AND confirm_tries = ?`,
      )
      .run(now, now, o.id, a.attempt, a.state, a.confirm_tries);
    if (!Number(r.changes)) return ['attempt moved'];
    moveFulfilment(d.orders, d.clock, o.id, 'confirming', 'job', a.attempt);
    return [];
  });
  if (go.length) {
    if (go[0] !== 'attempt moved') blocked(d, o.id, go);
    return 'blocked';
  }
  try {
    const confirmed = await d.provider.confirm!(po.id);
    adoptProviderOrder(d.orders, d.clock, o.id, a.attempt, confirmed, 'job');
    d.log({ level: 'info', msg: 'order submitted', order: o.id, attempt: a.attempt });
    return 'submitted';
  } catch (e) {
    if (e instanceof ProviderError && e.kind === 'permanent') {
      // Refused: perhaps it was confirmed already. Read it.
      const now = await d.provider.getOrder(po.id);
      adoptProviderOrder(d.orders, d.clock, o.id, a.attempt, now, 'job');
      if (CONFIRMED.includes(now.status)) return 'submitted';
      hold(d, o.id, 'confirm_failed', 'Printful refused to confirm the order', { error: e.message.slice(0, 200) });
      return 'held';
    }
    // No answer: stays `confirming`; read back after the quiet period.
    throw new RetryLater(QUIET_PERIOD_MS, 'confirm answer lost');
  }
}

export function registerSubmitJob(runner: JobRunner, d: SubmitDeps): void {
  runner.register('order.submit', {
    // The retry window, not an attempt count, decides when to give up (06 §7).
    maxAttempts: 1_000,
    backoffMs: (n) => Math.min(30_000 * 2 ** (n - 1), 30 * 60_000),
    async run(ctx) {
      const { orderId } = ctx.payload as { orderId: string };
      const outcome = await submitOrder(d, orderId);
      if (outcome === 'waiting') throw new RetryLater(COSTS_POLL_MS);
    },
  });
}
