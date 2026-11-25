/**
 * The admin's orders (docs/design/08 §3): the list, one order with everything
 * the shop knows about it, and Klaus's actions on holds and refunds.
 *
 * Every action is a POST with the CSRF token and a ticked "I'm sure" box,
 * resolves its hold with a conditional update (only the first action wins),
 * and is written to `admin_audit`. Actions only change rows and queue jobs:
 * the jobs talk to Stripe and Printful.
 */
import type { Request, Response, Router } from 'express';
import { iso, type Clock } from '../clock';
import type { Mode, QuoteSettings } from '../config';
import { setSetting, transaction, type Db } from '../db';
import { enqueue } from '../jobs';
import { formatCents } from '../money';
import { REASONS } from '../orders/holds';
import { ORDER_ID } from '../orders/ids';
import { requestFullRefund } from '../orders/refunds';
import { customerStatus } from '../orders/status';
import { moveFulfilment, newestAttempt } from '../orders/submit';
import { esc } from '../pages';
import type { Session } from './session';

export interface AdminOrderDeps {
  orders: Db;
  clock: Clock;
  mode: Mode;
  quote?: QuoteSettings;
}

type AdminRequest = Request & { session?: Session; csrf?: string };
type Page = (res: Response, title: string, body: string) => void;
type Audit = (req: AdminRequest, action: string, target: string, details?: unknown) => void;

const MAX_ATTEMPTS = 3;
const REASON_TEXT: Record<string, string> = {
  amount: 'large amount', quantity: 'large quantity', repeat: 'repeat buyer', breaker: 'circuit breaker', risk: 'Radar risk',
  cost_guard: 'Printful costs more than allowed', provider_unavailable: 'Printful unavailable', fulfilment_blocked: 'submission blocked',
  amount_mismatch: 'payment does not match the order', provider_hold: 'on hold at Printful', early_fraud_warning: 'early fraud warning',
  dispute: 'dispute', refund_failed: 'refund failed', provider_refused: 'Printful refused the order', costs_failed: 'Printful could not price it',
  provider_failed: 'failed at Printful', confirm_failed: 'Printful did not confirm', provider_canceled: 'cancelled by Printful',
};

const when = (ms: number) => {
  const h = Math.round(Math.abs(ms) / 3_600_000);
  const t = h >= 48 ? `${Math.round(h / 24)} days` : h >= 1 ? `${h} h` : `${Math.max(1, Math.round(Math.abs(ms) / 60_000))} min`;
  return ms >= 0 ? `in ${t}` : `${t} ago`;
};

/** An action form: CSRF token, an "I'm sure" box, one button (08 §3: each action asks for confirmation). */
function action(path: string, label: string, csrf: string, extra = ''): string {
  const id = `sure-${path.replace(/[^a-z0-9]+/gi, '-')}`;
  return `<form method="post" action="${esc(path)}" class="action"><input type="hidden" name="_csrf" value="${esc(csrf)}">${extra}<label><input type="checkbox" name="sure" id="${esc(id)}" required> I'm sure</label> <button type="submit">${esc(label)}</button></form>`;
}

interface HoldRow {
  id: number;
  order_id: string;
  kind: string;
  reasons_json: string;
  since: string;
  deadline_at: string;
  deadline_action: string;
  resolved_at: string | null;
  resolution: string | null;
}

/** Open holds for the dashboard, soonest deadline first. */
export function holdsSection(d: AdminOrderDeps, csrf: string): string {
  const rows = d.orders
    .prepare('SELECT h.*, o.number FROM holds h JOIN orders o ON o.id = h.order_id WHERE h.resolved_at IS NULL ORDER BY h.deadline_at')
    .all() as unknown as Array<HoldRow & { number: string }>;
  const breaker = d.orders.prepare("SELECT value_json FROM settings WHERE key = 'breaker_reset_at'").get() as { value_json: string } | undefined;
  const list = rows.length
    ? `<ul class="holds">${rows
        .map((h) => {
          const reasons = (JSON.parse(h.reasons_json) as string[]).map((r) => REASON_TEXT[r] ?? r).join(', ');
          const left = Date.parse(h.deadline_at) - d.clock.now();
          const next = h.deadline_action === 'refund' ? `refunds automatically ${when(left)}` : `reminds again ${when(left)}`;
          return `<li><a href="/admin/orders/${esc(h.order_id)}">Order ${esc(h.number)}</a>: ${esc(h.kind)} hold, ${esc(reasons)}; ${esc(next)}.</li>`;
        })
        .join('')}</ul>`
    : '<p>No open holds.</p>';
  return `<h2>Open holds</h2>${list}
<h2>Circuit breaker</h2><p>Counts paid orders since ${breaker ? esc(JSON.parse(breaker.value_json) as string) : '24 hours ago'}.</p>
${action('/admin/breaker/reset', 'Reset the circuit breaker', csrf)}`;
}

export function registerOrderRoutes(r: Router, d: AdminOrderDeps, page: Page, audit: Audit): void {
  // ---- the list ----
  r.get('/orders', (req: AdminRequest, res) => {
    const q = String(req.query.q ?? '').trim().slice(0, 100);
    const where: string[] = [];
    const args: string[] = [];
    if (q) {
      where.push('(number = ? OR lower(email) = lower(?))');
      args.push(q, q);
    }
    const rows = d.orders
      .prepare(`SELECT o.*, (SELECT COUNT(*) FROM holds h WHERE h.order_id = o.id AND h.resolved_at IS NULL) AS holds FROM orders o ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT 100`)
      .all(...args) as Array<Record<string, any>>;
    const body = rows
      .map((o) => {
        const st = customerStatus({ payment_state: o.payment_state, fulfilment_state: o.fulfilment_state, refunded_cents: o.refunded_cents, shippedSomething: o.fulfilment_state.includes('shipped') || o.fulfilment_state === 'delivered' });
        return `<tr><th scope="row"><a href="/admin/orders/${esc(o.id)}">${esc(o.number)}</a></th><td>${esc(String(o.created_at).slice(0, 16).replace('T', ' '))}</td><td>${esc(st.text)}</td><td>${o.paid_cents != null ? `$${formatCents(o.paid_cents)}` : '—'}</td><td>${o.holds ? `<strong>${o.holds} open</strong>` : ''}</td></tr>`;
      })
      .join('');
    page(
      res,
      'Orders',
      `<h1>Orders</h1>
<form method="get" action="/admin/orders" class="search"><label for="q">Order number or e-mail</label> <input id="q" name="q" value="${esc(q)}"> <button type="submit">Search</button></form>
${rows.length ? `<table class="orders"><thead><tr><th scope="col">Order</th><th scope="col">Created (UTC)</th><th scope="col">Status</th><th scope="col">Paid</th><th scope="col">Holds</th></tr></thead><tbody>${body}</tbody></table>` : '<p>No orders.</p>'}`,
    );
  });

  // ---- one order ----
  r.get('/orders/:id', (req: AdminRequest, res) => {
    const id = String(req.params.id);
    const o = ORDER_ID.test(id) ? (d.orders.prepare('SELECT * FROM orders WHERE id = ?').get(id) as Record<string, any> | undefined) : undefined;
    if (!o) return res.status(404).type('text').send('no such order');
    const csrf = req.csrf!;
    const items = d.orders.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(id) as Array<Record<string, any>>;
    const holds = d.orders.prepare('SELECT * FROM holds WHERE order_id = ? ORDER BY id').all(id) as unknown as HoldRow[];
    const refunds = d.orders.prepare('SELECT * FROM refunds WHERE order_id = ? ORDER BY requested_at').all(id) as Array<Record<string, any>>;
    const attempts = d.orders.prepare('SELECT * FROM provider_orders WHERE order_id = ? ORDER BY attempt').all(id) as Array<Record<string, any>>;
    const shipments = d.orders.prepare('SELECT * FROM shipments WHERE order_id = ? ORDER BY shipped_at').all(id) as Array<Record<string, any>>;
    const events = d.orders.prepare('SELECT * FROM order_events WHERE order_id = ? ORDER BY id').all(id) as Array<Record<string, any>>;
    const newest = attempts.at(-1);

    // Amounts: paid, tax, Stripe's fee (estimate), Printful's cost, margin.
    const fee = d.quote && o.paid_cents != null ? Math.ceil((o.paid_cents * d.quote.stripeFeePct) / 100) + d.quote.stripeFeeFixedCents : undefined;
    const costs = newest?.costs_json ? (JSON.parse(newest.costs_json) as { totalCents?: number }) : undefined;
    const revenue = o.items_cents + o.shipping_cents;
    const margin = fee !== undefined && costs?.totalCents !== undefined ? revenue - fee - costs.totalCents - o.refunded_cents : undefined;
    const money = (c: number | null | undefined) => (c == null ? '—' : `$${formatCents(c)}`);

    // Actions by hold (08 §3).
    const open = holds.filter((h) => !h.resolved_at);
    const reasonsOf = (h: HoldRow) => JSON.parse(h.reasons_json) as string[];
    const holdActions = (h: HoldRow) => {
      const rs = reasonsOf(h);
      const out: string[] = [];
      if (h.kind === 'approval') out.push(action(`/admin/orders/${id}/holds/${h.id}/approve`, 'Approve and fulfil', csrf));
      if (h.kind === 'fraud' && o.dispute_state === 'warning') out.push(action(`/admin/orders/${id}/holds/${h.id}/false-alarm`, 'False alarm: fulfil', csrf));
      if (h.kind === 'fraud' && o.dispute_state === 'won') out.push(action(`/admin/orders/${id}/holds/${h.id}/approve`, 'Dispute won: fulfil', csrf));
      if (rs.includes('cost_guard') && newest && newest.state === 'draft') out.push(action(`/admin/orders/${id}/holds/${h.id}/confirm-anyway`, 'Confirm anyway', csrf));
      if (rs.includes('refund_failed')) {
        out.push(action(`/admin/orders/${id}/holds/${h.id}/retry-refund`, 'Retry refund', csrf));
        out.push(action(`/admin/orders/${id}/holds/${h.id}/fulfil-anyway`, 'Fulfil anyway', csrf));
      }
      if (h.kind === 'attention' && !rs.includes('refund_failed') && !rs.includes('cost_guard')) {
        out.push(action(`/admin/orders/${id}/holds/${h.id}/approve`, 'Problem fixed: carry on', csrf));
      }
      return out.join(' ');
    };
    const holdRows = holds
      .map((h) => {
        const rs = reasonsOf(h).map((x) => REASON_TEXT[x] ?? x).join(', ');
        const state = h.resolved_at
          ? `resolved ${esc(h.resolution ?? '')} ${esc(h.resolved_at.slice(0, 16).replace('T', ' '))}`
          : `${h.deadline_action === 'refund' ? 'refunds automatically' : 'reminds'} ${when(Date.parse(h.deadline_at) - d.clock.now())}`;
        return `<li>${esc(h.kind)}: ${esc(rs)}; ${state}${h.resolved_at ? '' : `<br>${holdActions(h)}`}</li>`;
      })
      .join('');

    const shopRefund = refunds.some((x) => x.purpose !== 'dashboard' && (x.state === 'requested' || x.state === 'succeeded'));
    const refundable = ['paid', 'partially_refunded'].includes(o.payment_state) && !shopRefund && !['open', 'lost'].includes(o.dispute_state);
    const inProduction = ['in_production', 'partially_shipped', 'shipped', 'delivered'].includes(o.fulfilment_state);
    const orderActions: string[] = [];
    if (refundable && !inProduction) orderActions.push(action(`/admin/orders/${id}/refund`, 'Refund in full (and cancel at Printful)', csrf));
    if (refundable && inProduction) orderActions.push(action(`/admin/orders/${id}/refund-anyway`, 'Refund anyway (already in production)', csrf));
    if (newest && ['confirmed', 'draft', 'failed'].includes(newest.state) && !inProduction) orderActions.push(action(`/admin/orders/${id}/cancel`, 'Cancel at Printful', csrf));
    if (newest && ['canceled', 'deleted'].includes(newest.state) && newest.attempt < MAX_ATTEMPTS && ['paid', 'partially_refunded'].includes(o.payment_state)) {
      orderActions.push(action(`/admin/orders/${id}/retry`, `Retry submission (attempt ${newest.attempt + 1} of ${MAX_ATTEMPTS})`, csrf));
    }

    const stripeLink = o.stripe_payment_intent && d.mode !== 'mock'
      ? `<a href="https://dashboard.stripe.com/${d.mode === 'test' ? 'test/' : ''}payments/${esc(o.stripe_payment_intent)}" rel="noopener noreferrer">Stripe</a>`
      : '';
    const pfLink = (a: Record<string, any>) => (a.provider_order_id && d.mode !== 'mock' ? ` <a href="https://www.printful.com/dashboard?order_id=${esc(a.provider_order_id)}" rel="noopener noreferrer">Printful</a>` : '');

    page(
      res,
      `Order ${o.number}`,
      `<p><a href="/admin/orders">← Orders</a></p>
<h1>Order ${esc(o.number)}</h1>
<ul class="facts">
<li>Payment: <strong>${esc(o.payment_state)}</strong>; fulfilment: <strong>${esc(o.fulfilment_state)}</strong>; dispute: ${esc(o.dispute_state)}${o.completed_at ? `; complete since ${esc(String(o.completed_at).slice(0, 10))}` : ''}</li>
<li>Created ${esc(String(o.created_at).slice(0, 16).replace('T', ' '))} UTC; ${esc(o.email ?? '(purged)')}; ships to ${esc(o.ship_name ?? '')}, ${esc(o.ship_city ?? '')}, ${esc(o.ship_state ?? '')} ${esc(o.ship_zip ?? '')} by ${esc(o.shipping_method)}</li>
<li>Paid ${money(o.paid_cents)} (tax ${money(o.tax_cents)}); refunded ${money(o.refunded_cents)}; Stripe fee about ${money(fee)}; Printful ${money(costs?.totalCents)}; margin ${money(margin)} ${stripeLink}</li>
</ul>
<h2>Items</h2><table class="lines"><tbody>${items.map((i) => `<tr><th scope="row">${esc(i.name)}</th><td>${i.quantity} × $${formatCents(i.unit_cents)}</td><td>${esc(i.source_id)}/${esc(i.work_id)}</td></tr>`).join('')}</tbody></table>
<h2>Holds</h2>${holds.length ? `<ul class="holds">${holdRows}</ul>` : '<p>None.</p>'}
<h2>Actions</h2>${orderActions.length ? orderActions.join('\n') : '<p>None available.</p>'}
<h2>Refunds</h2>${refunds.length ? `<ul>${refunds.map((x) => `<li>${esc(x.purpose)} ${money(x.amount_cents)}: ${esc(x.state)}${x.last_error ? ` (${esc(x.last_error)})` : ''}, by ${esc(x.requested_by)}</li>`).join('')}</ul>` : '<p>None.</p>'}
<h2>At Printful</h2>${attempts.length ? `<ul>${attempts.map((a) => `<li>Attempt ${a.attempt}${a.kind === 'reship' ? ' (reshipment)' : ''}: ${esc(a.state)}${a.status ? ` (${esc(a.status)})` : ''}${a.override_at ? `; confirmed anyway by ${esc(a.override_by)}` : ''}${a.last_error ? `; ${esc(a.last_error)}` : ''}${pfLink(a)}</li>`).join('')}</ul>` : '<p>Nothing sent.</p>'}
<h2>Shipments</h2>${shipments.length ? `<ul>${shipments.map((s) => `<li>${esc(s.carrier ?? '')} ${esc(s.tracking_number ?? '')}: ${esc(s.shipment_status ?? '')}, ${esc(s.delivery_status ?? '')}</li>`).join('')}</ul>` : '<p>None.</p>'}
<h2>History</h2><ol class="events">${events.map((e) => `<li>${esc(String(e.at).slice(0, 19).replace('T', ' '))} ${esc(e.part)}${e.attempt ? ` #${e.attempt}` : ''}: ${esc(e.from_value ?? '')} → ${esc(e.to_value ?? '')} (${esc(e.cause)}${e.note ? `, ${esc(e.note)}` : ''})</li>`).join('')}</ol>`,
    );
  });

  // ---- actions ----
  const sure = (req: AdminRequest, res: Response) => {
    if ((req.body as Record<string, unknown>)?.sure === 'on') return true;
    res.status(400).type('text').send('tick "I\'m sure" to go ahead');
    return false;
  };
  const back = (res: Response, id: string) => res.redirect(303, `/admin/orders/${id}`);
  const params = (req: AdminRequest) => ({ id: String(req.params.id), holdId: Number(req.params.hold) });
  /** Resolve one open hold of this order; only the first action wins. */
  const resolve = (id: string, holdId: number, resolution: string, by: string) =>
    Number(
      d.orders.prepare('UPDATE holds SET resolved_at = ?, resolved_by = ?, resolution = ? WHERE id = ? AND order_id = ? AND resolved_at IS NULL').run(iso(d.clock), by, resolution, holdId, id).changes,
    ) > 0;
  const holdOf = (id: string, holdId: number) => d.orders.prepare('SELECT * FROM holds WHERE id = ? AND order_id = ?').get(holdId, id) as HoldRow | undefined;
  const note = (id: string, to: string, by: string, what: string) =>
    d.orders.prepare("INSERT INTO order_events (order_id, part, to_value, cause, cause_ref, note, at) VALUES (?, 'hold', ?, 'admin', ?, ?, ?)").run(id, to, by, what, iso(d.clock));
  const submit = (id: string) => enqueue(d.orders, d.clock, 'order.submit', id, { orderId: id });

  const holdAction = (name: string, allowed: (h: HoldRow, o: Record<string, any>) => boolean, apply: (id: string, h: HoldRow, by: string) => void) =>
    r.post(`/orders/:id/holds/:hold/${name}`, (req: AdminRequest, res) => {
      if (!sure(req, res)) return;
      const { id, holdId } = params(req);
      const by = req.session!.email;
      const done = transaction(d.orders, () => {
        const h = holdOf(id, holdId);
        const o = d.orders.prepare('SELECT * FROM orders WHERE id = ?').get(id) as Record<string, any> | undefined;
        if (!h || !o || h.resolved_at || !allowed(h, o)) return false;
        if (!resolve(id, holdId, 'approved', by)) return false;
        note(id, 'resolved', by, name);
        apply(id, h, by);
        return true;
      });
      audit(req, `order.${name}`, id, { hold: holdId, done });
      if (!done) return res.status(409).type('text').send('this hold was already resolved, or the action does not apply');
      back(res, id);
    });

  const REFUND_REASONS = new Set(Object.entries(REASONS).filter(([, v]) => v.kind === 'attention').map(([k]) => k));
  holdAction('approve', (h, o) => h.kind === 'approval' || (h.kind === 'fraud' && o.dispute_state === 'won') || (h.kind === 'attention' && (JSON.parse(h.reasons_json) as string[]).every((x) => REFUND_REASONS.has(x) && x !== 'refund_failed' && x !== 'cost_guard')), (id) => submit(id));
  holdAction('false-alarm', (h, o) => h.kind === 'fraud' && o.dispute_state === 'warning', (id) => {
    d.orders.prepare("UPDATE orders SET dispute_state = 'none', updated_at = ? WHERE id = ? AND dispute_state = 'warning'").run(iso(d.clock), id);
    d.orders.prepare("INSERT INTO order_events (order_id, part, from_value, to_value, cause, at) VALUES (?, 'dispute', 'warning', 'none', 'admin', ?)").run(id, iso(d.clock));
    submit(id);
  });
  holdAction('confirm-anyway', (h) => (JSON.parse(h.reasons_json) as string[]).includes('cost_guard'), (id, _h, by) => {
    const a = newestAttempt(d.orders, id);
    if (a) d.orders.prepare("UPDATE provider_orders SET override_by = ?, override_at = ? WHERE order_id = ? AND provider = 'printful' AND attempt = ?").run(by, iso(d.clock), id, a.attempt);
    submit(id);
  });
  holdAction('retry-refund', (h) => (JSON.parse(h.reasons_json) as string[]).includes('refund_failed'), (id, _h, by) => {
    requestFullRefund(d, id, 'cancel', by);
  });
  holdAction('fulfil-anyway', (h) => (JSON.parse(h.reasons_json) as string[]).includes('refund_failed'), (id) => submit(id));

  r.post('/orders/:id/refund', (req: AdminRequest, res) => refundAction(req, res, 'cancel'));
  r.post('/orders/:id/refund-anyway', (req: AdminRequest, res) => refundAction(req, res, 'anyway'));
  function refundAction(req: AdminRequest, res: Response, purpose: 'cancel' | 'anyway') {
    if (!sure(req, res)) return;
    const id = String(req.params.id);
    const o = d.orders.prepare('SELECT payment_state, dispute_state FROM orders WHERE id = ?').get(id) as { payment_state: string; dispute_state: string } | undefined;
    if (!o || !['paid', 'partially_refunded'].includes(o.payment_state) || ['open', 'lost'].includes(o.dispute_state)) {
      return res.status(409).type('text').send('this order cannot be refunded now');
    }
    const refundId = requestFullRefund(d, id, purpose, req.session!.email);
    audit(req, `order.refund.${purpose}`, id, { refund: refundId });
    back(res, id);
  }

  r.post('/orders/:id/cancel', (req: AdminRequest, res) => {
    if (!sure(req, res)) return;
    const id = String(req.params.id);
    enqueue(d.orders, d.clock, 'order.cancel', id, { orderId: id });
    audit(req, 'order.cancel', id);
    back(res, id);
  });

  r.post('/orders/:id/retry', (req: AdminRequest, res) => {
    if (!sure(req, res)) return;
    const id = String(req.params.id);
    const by = req.session!.email;
    // Attempt N+1 only after attempt N is proven cancelled or deleted, N < 3 (I5); every open hold is released by this decision.
    const n = transaction(d.orders, () => {
      const a = newestAttempt(d.orders, id);
      const o = d.orders.prepare('SELECT payment_state FROM orders WHERE id = ?').get(id) as { payment_state: string } | undefined;
      if (!a || !o || !['canceled', 'deleted'].includes(a.state) || a.attempt >= MAX_ATTEMPTS || !['paid', 'partially_refunded'].includes(o.payment_state)) return 0;
      const now = iso(d.clock);
      d.orders.prepare("UPDATE holds SET resolved_at = ?, resolved_by = ?, resolution = 'approved' WHERE order_id = ? AND resolved_at IS NULL").run(now, by, id);
      const next = a.attempt + 1;
      d.orders.prepare("INSERT INTO provider_orders (order_id, provider, attempt, external_id, state, updated_at) VALUES (?, 'printful', ?, ?, 'submitting', ?)").run(id, next, `${id}-${next}`, now);
      moveFulfilment(d.orders, d.clock, id, 'submitting', 'admin', next, `retry by ${by}`);
      submit(id);
      return next;
    });
    audit(req, 'order.retry', id, { attempt: n || null });
    if (!n) return res.status(409).type('text').send('a new attempt needs the last one cancelled or deleted, and at most 3 attempts');
    back(res, id);
  });

  r.post('/breaker/reset', (req: AdminRequest, res) => {
    if (!sure(req, res)) return;
    const now = iso(d.clock);
    transaction(d.orders, () => {
      setSetting(d.orders, 'breaker_reset_at', now, now, req.session!.email);
      // Holds whose only reason is the breaker are released (07 §2.5).
      const held = d.orders.prepare("SELECT id, order_id FROM holds WHERE resolved_at IS NULL AND reasons_json = '[\"breaker\"]'").all() as Array<{ id: number; order_id: string }>;
      for (const h of held) {
        if (resolve(h.order_id, h.id, 'released', req.session!.email)) submit(h.order_id);
      }
    });
    audit(req, 'breaker.reset', 'breaker');
    res.redirect(303, '/admin');
  });
}
