/**
 * Sending (docs/design/09): `email.send` for customer e-mails, at most once
 * per (order, kind, ref) and retried up to 5 times; `alert.send` for Klaus.
 *
 * - `EMAIL_ENABLED` is the kill switch for customer e-mails; in mock and test
 *   mode they go only to `EMAIL_ALLOWLIST`.
 * - Alerts carry the order number and an admin link, never the customer's
 *   name, address or e-mail (review C F14): only allow-listed fields of a log
 *   line are used. The same alert is sent at most once a day.
 * - Bounces and complaints go to the feedback address (ADR-0038).
 */
import { createHash } from 'node:crypto';
import { iso, type Clock } from '../clock';
import type { Config, Mode } from '../config';
import { setSetting, type Db } from '../db';
import { enqueue, PermanentJobError, type JobRunner } from '../jobs';
import { recordEvent } from '../orders/holds';
import { statusUrl } from '../orders/ids';
import { ALERT_ACCEPTED_KEY, ALERT_FAILED_KEY } from '../worker-health';
import { SesError, type SesClient } from './ses';
import { confirmationEmail, delayedEmail, linkEmail, refundedEmail, shippedEmail, type Email, type OrderView } from './templates';

export interface EmailDeps {
  orders: Db;
  clock: Clock;
  mode: Mode;
  publicUrl: string;
  shopName: string;
  statusSecret: string;
  email: Config['email'];
  ses?: SesClient;
  log: (line: Record<string, unknown>) => void;
}

export type EmailKind = 'confirmation' | 'shipped' | 'delayed' | 'refunded' | 'link';
const MAX_TRIES = 5;

interface Payload {
  orderId: string;
  kind: string;
  ref?: string;
  shipmentId?: string;
}

/** Queue a customer e-mail; one per (order, kind, ref). */
export function queueEmail(db: Db, clock: Clock, orderId: string, kind: EmailKind, ref = ''): void {
  enqueue(db, clock, 'email.send', `${orderId}/${kind}${ref ? `/${ref}` : ''}`, { orderId, kind, ref });
}

function view(db: Db, orderId: string): (OrderView & { email: string | null }) | undefined {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as Record<string, any> | undefined;
  if (!o) return undefined;
  const items = db.prepare('SELECT name, quantity, unit_cents FROM order_items WHERE order_id = ? ORDER BY id').all(orderId) as Array<{ name: string; quantity: number; unit_cents: number }>;
  return {
    email: o.email,
    number: o.number,
    shipName: o.ship_name ?? '',
    shipCity: o.ship_city ?? '',
    shipState: o.ship_state ?? '',
    items: items.map((i) => ({ name: i.name, quantity: i.quantity, unitCents: i.unit_cents })),
    itemsCents: o.items_cents,
    shippingCents: o.shipping_cents,
    taxCents: o.tax_cents ?? 0,
    paidCents: o.paid_cents ?? 0,
    refundedCents: o.refunded_cents,
  };
}

export function composeEmail(d: Pick<EmailDeps, 'orders' | 'publicUrl' | 'shopName' | 'statusSecret'>, p: Payload): (Email & { to: string | null }) | undefined {
  const o = view(d.orders, p.orderId);
  if (!o) return undefined;
  const url = statusUrl(d, p.orderId);
  const kind = p.kind === 'shipment' ? 'shipped' : p.kind;
  let mail: Email;
  switch (kind) {
    case 'confirmation':
      mail = confirmationEmail(o, d.shopName, url);
      break;
    case 'shipped': {
      const sid = p.shipmentId ?? p.ref;
      const s = d.orders.prepare("SELECT * FROM shipments WHERE provider = 'printful' AND id = ?").get(String(sid)) as Record<string, any> | undefined;
      if (!s) return undefined;
      // The items in this parcel by their order item ids; "more to come" while other items aren't shipped yet.
      const byId = new Map((d.orders.prepare('SELECT id, name, quantity FROM order_items WHERE order_id = ?').all(p.orderId) as Array<{ id: string; name: string; quantity: number }>).map((i) => [i.id, i]));
      const inParcel = (JSON.parse(s.items_json) as Array<{ order_item_external_id?: string; quantity?: number }>)
        .map((x) => byId.get(String(x.order_item_external_id)) && `${byId.get(String(x.order_item_external_id))!.name} × ${x.quantity ?? 1}`)
        .filter((x): x is string => !!x);
      const shippedQty = (d.orders.prepare("SELECT items_json FROM shipments WHERE order_id = ? AND shipment_status != 'canceled'").all(p.orderId) as Array<{ items_json: string }>)
        .flatMap((r) => JSON.parse(r.items_json) as Array<{ quantity?: number }>)
        .reduce((t, x) => t + (x.quantity ?? 1), 0);
      const total = o.items.reduce((t, i) => t + i.quantity, 0);
      mail = shippedEmail(o, {
        carrier: s.carrier, service: s.service, trackingNumber: s.tracking_number, trackingUrl: s.tracking_url,
        estimatedFrom: s.estimated_from, estimatedTo: s.estimated_to, items: inParcel, more: shippedQty < total,
      }, d.shopName, url);
      break;
    }
    case 'delayed':
      mail = delayedEmail(o, d.shopName, url);
      break;
    case 'refunded': {
      const shipped = (d.orders.prepare("SELECT COUNT(*) n FROM shipments WHERE order_id = ? AND shipment_status = 'shipped'").get(p.orderId) as { n: number }).n > 0;
      mail = refundedEmail(o, d.shopName, url, shipped);
      break;
    }
    case 'link':
      mail = linkEmail(o, d.shopName, url);
      break;
    default:
      return undefined;
  }
  return { ...mail, to: o.email };
}

export async function sendCustomerEmail(d: EmailDeps, p: Payload): Promise<'sent' | 'already' | 'skipped' | 'suppressed'> {
  const kind = p.kind === 'shipment' ? 'shipped' : p.kind;
  const ref = p.ref ?? p.shipmentId ?? '';
  d.orders.prepare('INSERT OR IGNORE INTO emails (order_id, kind, ref) VALUES (?, ?, ?)').run(p.orderId, kind, ref);
  const row = d.orders.prepare('SELECT sent_at, attempts FROM emails WHERE order_id = ? AND kind = ? AND ref = ?').get(p.orderId, kind, ref) as { sent_at: string | null; attempts: number };
  if (row.sent_at) return 'already';
  const note = (err: string) =>
    d.orders.prepare('UPDATE emails SET last_error = ? WHERE order_id = ? AND kind = ? AND ref = ?').run(err, p.orderId, kind, ref);
  if (!d.email.enabled || !d.ses) {
    note('e-mail is switched off');
    return 'skipped';
  }
  const mail = composeEmail(d, { ...p, kind });
  if (!mail || !mail.to) {
    note('nothing to send (no order, shipment or address)');
    return 'skipped';
  }
  if (d.mode !== 'live' && !d.email.allowlist.includes(mail.to.toLowerCase())) {
    note(`${d.mode} mode: recipient not on EMAIL_ALLOWLIST`);
    return 'suppressed';
  }
  d.orders.prepare('UPDATE emails SET attempts = attempts + 1 WHERE order_id = ? AND kind = ? AND ref = ?').run(p.orderId, kind, ref);
  try {
    await d.ses.send({ from: `${d.shopName} <${d.email.from}>`, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html, feedbackTo: d.email.feedbackTo });
  } catch (e) {
    const msg = (e as Error).message.slice(0, 300);
    note(msg);
    if ((e instanceof SesError && e.permanent) || row.attempts + 1 >= MAX_TRIES) {
      d.log({ level: 'alert', msg: 'customer e-mail not sent', order: p.orderId, kind });
      throw new PermanentJobError(msg);
    }
    throw e;
  }
  d.orders.prepare('UPDATE emails SET sent_at = ?, last_error = NULL WHERE order_id = ? AND kind = ? AND ref = ?').run(iso(d.clock), p.orderId, kind, ref);
  recordEvent(d.orders, d.clock, { orderId: p.orderId, part: 'email', to: kind, cause: 'job', note: ref || null });
  return 'sent';
}

// ---------------------------------------------------------------- alerts (09 §2)

/** The only fields of a log line an alert may carry: no names, addresses, e-mails or provider messages. */
const ALERT_FIELDS = ['order', 'attempt', 'kind', 'type', 'reasons', 'why', 'cost', 'allowed', 'alarms', 'source', 'sku', 'hold'];

export interface AlertPayload {
  msg: string;
  fields: Record<string, unknown>;
}

/**
 * Wrap the process log: every `level: 'alert'` line also queues `alert.send`,
 * at most once a day per message and order (or per `alertKey`).
 */
export function alertingLog(
  base: (line: Record<string, unknown>) => void,
  orders: Db,
  clock: Clock,
  opts: { alertNewOrders: boolean },
): (line: Record<string, unknown>) => void {
  return (line) => {
    base(line);
    const isNewOrder = line.msg === 'payment applied' && opts.alertNewOrders;
    if (line.level !== 'alert' && !isNewOrder) return;
    const fields = Object.fromEntries(Object.entries(line).filter(([k]) => ALERT_FIELDS.includes(k)));
    const msg = isNewOrder ? 'new paid order' : String(line.msg);
    const day = new Date(clock.now()).toISOString().slice(0, 10);
    const key = String(line.alertKey ?? createHash('sha256').update(`${msg}|${String(line.order ?? '')}|${day}`).digest('hex').slice(0, 32));
    try {
      enqueue(orders, clock, 'alert.send', key, { msg, fields } satisfies AlertPayload);
    } catch {
      // An alert must never break the work that raised it.
    }
  };
}

export async function sendAlert(d: EmailDeps, a: AlertPayload): Promise<'sent' | 'skipped'> {
  if (!d.ses || !d.email.alertTo) return 'skipped';
  const orderId = typeof a.fields.order === 'string' ? a.fields.order : undefined;
  const number = orderId ? (d.orders.prepare('SELECT number FROM orders WHERE id = ?').get(orderId) as { number: string } | undefined)?.number : undefined;
  const label = `[${d.mode.toUpperCase()}] ${a.msg}${number ? `: order ${number}` : ''}`;
  const lines = Object.entries(a.fields)
    .filter(([k]) => k !== 'order')
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join('; ') : typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
  const link = orderId ? `${d.publicUrl}/admin/orders/${orderId}` : `${d.publicUrl}/admin`;
  const text = `${label}\n\n${lines.join('\n')}\n\n${link}\n`;
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(label)}</title></head><body><h1 style="font-size:1.1rem">${esc(label)}</h1>${lines.length ? `<ul>${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}<p><a href="${esc(link)}">${esc(link)}</a></p></body></html>`;
  try {
    await d.ses.send({ from: `${d.shopName} <${d.email.from}>`, to: d.email.alertTo, subject: label.slice(0, 150), text, html, feedbackTo: d.email.feedbackTo });
  } catch (e) {
    setSetting(d.orders, ALERT_FAILED_KEY, iso(d.clock), iso(d.clock));
    throw e;
  }
  setSetting(d.orders, ALERT_ACCEPTED_KEY, iso(d.clock), iso(d.clock));
  return 'sent';
}

export function registerEmailJobs(runner: JobRunner, d: EmailDeps): void {
  runner.register('email.send', {
    maxAttempts: MAX_TRIES,
    async run(ctx) {
      await sendCustomerEmail(d, ctx.payload as Payload);
    },
  });
  runner.register('alert.send', {
    maxAttempts: 10,
    backoffMs: (n) => Math.min(60_000 * 2 ** (n - 1), 60 * 60_000),
    async run(ctx) {
      await sendAlert(d, ctx.payload as AlertPayload);
    },
  });
}

