/**
 * Printful's webhooks and what they change (docs/design/06 §5, 07 §2.3–2.4).
 *
 * POST /webhooks/printful verifies the delivery, stores it once in
 * `inbound_events` (raw body and signature headers, no customer data, 30
 * days) and enqueues `printful.event`. The job resolves the event to an
 * attempt by external id, re-fetches the order and its shipments, and only the
 * newest attempt moves `fulfilment_state`.
 */
import express, { type Router } from 'express';
import { perClient } from '../limiter';
import { iso, type Clock } from '../clock';
import { transaction, type Db } from '../db';
import { enqueue, PermanentJobError, type JobRunner } from '../jobs';
import { verifyPrintfulWebhook } from '../providers/printful-webhook';
import { ProviderError, type FulfilmentProvider } from '../providers/types';
import { openHold } from './holds';
import { adoptProviderOrder, moveFulfilment, newestAttempt, type AttemptRow } from './submit';

export interface PrintfulWebhookDeps {
  orders: Db;
  clock: Clock;
  secretHex?: string;
  publicKey?: string;
  /** The verified store; undefined until Printful's identity is checked. */
  storeId: () => string | undefined;
  log: (line: Record<string, unknown>) => void;
}

export function printfulWebhookRouter(d: PrintfulWebhookDeps): Router {
  const r = express.Router();
  const limiter = perClient(60_000, 600);
  r.post('/webhooks/printful', limiter, express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
    const storeId = d.storeId();
    if (!d.secretHex || !d.publicKey || !storeId) return res.status(503).json({ error: 'not ready' });
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const signature = req.get('x-pf-webhook-signature');
    const publicKey = req.get('x-pf-webhook-public-key');
    const check = verifyPrintfulWebhook(raw, { signature, publicKey }, { secretHex: d.secretHex, publicKey: d.publicKey, storeId }, d.clock.now());
    if (!check.ok) {
      d.log({ level: 'warn', msg: 'printful webhook refused', reason: check.reason });
      return res.status(400).json({ error: 'refused' });
    }
    const ev = check.event;
    const payload = JSON.stringify({ body: raw.toString('utf8'), signature, publicKey, externalId: ev.externalId ?? null, shipmentId: ev.shipmentId ?? null });
    const inserted = d.orders
      .prepare(`INSERT OR IGNORE INTO inbound_events (provider, event_id, type, object_id, payload_json, received_at) VALUES ('printful', ?, ?, ?, ?, ?)`)
      .run(ev.eventId, ev.type, ev.providerOrderId ?? null, payload, iso(d.clock));
    if (Number(inserted.changes)) enqueue(d.orders, d.clock, 'printful.event', ev.eventId, { eventId: ev.eventId });
    res.json({ received: true });
  });
  return r;
}

export interface FulfilmentEventDeps {
  orders: Db;
  clock: Clock;
  provider: FulfilmentProvider;
  log: (line: Record<string, unknown>) => void;
}

const SHIPMENT_TROUBLE = new Set(['shipment_put_hold', 'shipment_put_hold_approval', 'shipment_out_of_stock', 'shipment_canceled', 'shipment_returned']);

function hold(d: FulfilmentEventDeps, orderId: string, reason: string) {
  const open = d.orders.prepare('SELECT reasons_json FROM holds WHERE order_id = ? AND resolved_at IS NULL').all(orderId) as Array<{ reasons_json: string }>;
  if (!open.some((h) => (JSON.parse(h.reasons_json) as string[]).includes(reason))) openHold(d.orders, d.clock, orderId, [reason], 'printful_webhook');
}

/** Upsert the attempt's shipments; all delivered → `delivered` and complete (07 §2.7). New parcels get their e-mail. */
export async function syncShipments(d: FulfilmentEventDeps, a: AttemptRow): Promise<number> {
  const list = await d.provider.getShipments(a.provider_order_id!);
  return transaction(d.orders, () => {
    let added = 0;
    const exists = d.orders.prepare("SELECT 1 FROM shipments WHERE provider = 'printful' AND id = ?");
    const upsert = d.orders.prepare(`
      INSERT INTO shipments (provider, id, order_id, attempt, carrier, service, tracking_number, tracking_url, shipped_at, delivered_at,
                             estimated_from, estimated_to, shipment_status, delivery_status, is_reshipment, items_json)
      VALUES ('printful', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (provider, id) DO UPDATE SET carrier = excluded.carrier, service = excluded.service,
        tracking_number = excluded.tracking_number, tracking_url = excluded.tracking_url, shipped_at = excluded.shipped_at,
        delivered_at = excluded.delivered_at, estimated_from = excluded.estimated_from, estimated_to = excluded.estimated_to,
        shipment_status = excluded.shipment_status, delivery_status = excluded.delivery_status, items_json = excluded.items_json`);
    for (const s of list) {
      const isNew = !exists.get(s.id);
      upsert.run(s.id, a.order_id, a.attempt, s.carrier, s.service, s.trackingNumber, s.trackingUrl, s.shippedAt, s.deliveredAt,
        s.estimatedFrom, s.estimatedTo, s.shipmentStatus, s.deliveryStatus, s.isReshipment ? 1 : 0, JSON.stringify(s.items));
      if (isNew && s.shipmentStatus === 'shipped') {
        added++;
        enqueue(d.orders, d.clock, 'email.send', `${a.order_id}/shipment/${s.id}`, { orderId: a.order_id, kind: 'shipment', shipmentId: s.id });
      }
    }
    const live = list.filter((s) => s.shipmentStatus !== 'canceled');
    const o = d.orders.prepare('SELECT fulfilment_state f FROM orders WHERE id = ?').get(a.order_id) as { f: string };
    if (o.f === 'shipped' && live.length > 0 && live.every((s) => s.deliveryStatus === 'delivered')) {
      if (moveFulfilment(d.orders, d.clock, a.order_id, 'delivered', 'printful_webhook', a.attempt)) {
        d.orders.prepare('UPDATE orders SET completed_at = COALESCE(completed_at, ?) WHERE id = ?').run(iso(d.clock), a.order_id);
      }
    }
    return added;
  });
}

export async function applyPrintfulEvent(d: FulfilmentEventDeps, eventId: string): Promise<string> {
  const ev = d.orders.prepare(`SELECT type, object_id, payload_json FROM inbound_events WHERE provider = 'printful' AND event_id = ?`).get(eventId) as
    | { type: string; object_id: string | null; payload_json: string }
    | undefined;
  if (!ev) return 'gone';
  const { externalId } = JSON.parse(ev.payload_json) as { externalId: string | null };
  const a = (externalId
    ? d.orders.prepare("SELECT * FROM provider_orders WHERE provider = 'printful' AND external_id = ?").get(externalId)
    : d.orders.prepare("SELECT * FROM provider_orders WHERE provider = 'printful' AND provider_order_id = ?").get(ev.object_id)) as AttemptRow | undefined;
  if (!a) {
    // A reshipment made in the dashboard, or an order this shop never made: the reverse sweep (07 §5) raises it.
    d.log({ level: 'warn', msg: 'printful event for an unknown order', type: ev.type });
    return 'unknown_order';
  }
  const before = a.state;
  const providerOrderId = a.provider_order_id ?? ev.object_id;
  if (!providerOrderId) return 'no order id';
  if (!a.provider_order_id) d.orders.prepare("UPDATE provider_orders SET provider_order_id = ? WHERE order_id = ? AND attempt = ?").run(providerOrderId, a.order_id, a.attempt);
  let po;
  try {
    po = await d.provider.getOrder(providerOrderId);
  } catch (e) {
    if (e instanceof ProviderError && e.status === 404) return before === 'deleted' ? 'deleted by the shop' : 'order not found';
    throw e;
  }
  adoptProviderOrder(d.orders, d.clock, a.order_id, a.attempt, po, 'printful_webhook');
  const newest = newestAttempt(d.orders, a.order_id)?.attempt === a.attempt;
  const fresh = { ...a, provider_order_id: providerOrderId };
  const note = (msg: string) => d.log({ level: 'alert', msg, order: a.order_id, attempt: a.attempt, type: ev.type });

  switch (ev.type) {
    case 'order_failed':
      if (newest) transaction(d.orders, () => hold(d, a.order_id, 'provider_failed'));
      note('Printful reports the order failed');
      return 'failed';
    case 'order_canceled':
      if (before === 'canceled' || before === 'deleted') return 'own cancel';
      if (newest) transaction(d.orders, () => hold(d, a.order_id, 'provider_canceled'));
      note('Printful cancelled the order');
      return 'canceled by provider';
    case 'order_put_hold':
    case 'order_put_hold_approval':
      transaction(d.orders, () => hold(d, a.order_id, 'provider_hold'));
      note('Printful put the order on hold');
      return 'provider hold';
    case 'order_remove_hold': {
      const r = d.orders
        .prepare("UPDATE holds SET resolved_at = ?, resolved_by = 'printful', resolution = 'cleared' WHERE order_id = ? AND kind = 'provider' AND resolved_at IS NULL")
        .run(iso(d.clock), a.order_id);
      return Number(r.changes) ? 'hold cleared' : 'no hold';
    }
    case 'order_refunded':
      note('Printful refunded the store');
      return 'provider refund';
    case 'approval_sheet_status_changed':
      note('Printful asks for an approval');
      return 'approval sheet';
    default:
      if (ev.type.startsWith('shipment_')) {
        const added = await syncShipments(d, fresh);
        if (SHIPMENT_TROUBLE.has(ev.type)) note(`Printful: ${ev.type}`);
        return `shipments synced${added ? ` (+${added})` : ''}`;
      }
      return 'synced';
  }
}

export function registerPrintfulEventJob(runner: JobRunner, d: FulfilmentEventDeps): void {
  runner.register('printful.event', {
    maxAttempts: 10,
    async run(ctx) {
      const { eventId } = ctx.payload as { eventId: string };
      let outcome: string;
      try {
        outcome = await applyPrintfulEvent(d, eventId);
      } catch (e) {
        if (e instanceof ProviderError && e.kind === 'auth') throw new PermanentJobError(e.message);
        throw e;
      }
      d.orders.prepare(`UPDATE inbound_events SET processed_at = ?, outcome = ? WHERE provider = 'printful' AND event_id = ?`).run(iso(d.clock), outcome, eventId);
    },
  });
}
