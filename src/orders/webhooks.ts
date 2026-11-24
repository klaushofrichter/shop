/**
 * POST /webhooks/stripe (docs/design/05 §4): verify the signature over the raw
 * body, store the event once (inbound_events, unique id; a duplicate is 200),
 * enqueue, answer 200. The job re-fetches everything; from the payload only
 * id, type and data.object.id are used (review 1 F12), and only those three
 * are stored (review C F14).
 */
import express, { type Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { iso, type Clock } from '../clock';
import { type Db } from '../db';
import { enqueue, type JobRunner } from '../jobs';
import { verifyStripeWebhook } from '../payments/stripe';
import { applyPayment, closeUnpaid, type PaymentDeps } from './payment';

export interface WebhookDeps {
  orders: Db;
  clock: Clock;
  stripeWebhookSecret?: string;
  log: (line: Record<string, unknown>) => void;
}

export function webhookRouter(d: WebhookDeps): Router {
  const r = express.Router();
  // Stripe sends a handful of events per order; generous, but bounded.
  const limiter = rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: 'draft-8', legacyHeaders: false });
  r.post('/webhooks/stripe', limiter, express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
    if (!d.stripeWebhookSecret) return res.status(503).json({ error: 'not configured' });
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const ev = verifyStripeWebhook(raw, req.get('stripe-signature'), d.stripeWebhookSecret, d.clock.now());
    if (!ev) {
      d.log({ level: 'warn', msg: 'stripe webhook signature refused' });
      return res.status(400).json({ error: 'signature' });
    }
    const inserted = d.orders
      .prepare(`INSERT OR IGNORE INTO inbound_events (provider, event_id, type, object_id, received_at) VALUES ('stripe', ?, ?, ?, ?)`)
      .run(ev.id, ev.type, ev.objectId, iso(d.clock));
    if (Number(inserted.changes)) enqueue(d.orders, d.clock, 'stripe.event', ev.id, { eventId: ev.id });
    res.json({ received: true });
  });
  return r;
}

/** The job behind each stored event (05 §4). Refunds, disputes and fraud warnings arrive with step 7. */
export function registerStripeEventJob(runner: JobRunner, d: PaymentDeps): void {
  runner.register('stripe.event', {
    maxAttempts: 10,
    async run(ctx) {
      const { eventId } = ctx.payload as { eventId: string };
      const ev = d.orders.prepare(`SELECT type, object_id FROM inbound_events WHERE provider = 'stripe' AND event_id = ?`).get(eventId) as { type: string; object_id: string } | undefined;
      if (!ev) return;
      let outcome: string;
      switch (ev.type) {
        case 'checkout.session.completed':
        case 'checkout.session.async_payment_succeeded':
          outcome = await applyPayment(d, ev.object_id);
          break;
        case 'checkout.session.expired':
        case 'checkout.session.async_payment_failed': {
          // Re-read: a session that was paid after all wins (I1).
          const s = await d.stripe.getCheckoutSession(ev.object_id);
          if (s.payment_status === 'paid') outcome = await applyPayment(d, ev.object_id);
          else {
            const o = d.orders.prepare('SELECT id FROM orders WHERE stripe_session_id = ?').get(ev.object_id) as { id: string } | undefined;
            outcome = o && closeUnpaid(d.orders, d.clock, o.id, 'stripe') ? 'closed_unpaid' : 'unchanged';
          }
          break;
        }
        default:
          outcome = 'not handled yet';
          d.log({ level: 'warn', msg: 'stripe event not handled yet', type: ev.type });
      }
      d.orders.prepare(`UPDATE inbound_events SET processed_at = ?, outcome = ? WHERE provider = 'stripe' AND event_id = ?`).run(iso(d.clock), outcome, eventId);
    },
  });
}
