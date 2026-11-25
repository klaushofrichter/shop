/**
 * Mock Stripe, stage 2 (docs/design/14 §5): Customers, Checkout Sessions with
 * the shop's parameters checked against a hand-written allow-list, line
 * items, expire, a checkout page (Pay / Decline / Cancel), payments with a
 * charge (risk level and fingerprint settable or absent), a tax table (one
 * state taxes shipping, one doesn't), idempotency as captured, the pinned API
 * version only, signed webhooks to the shop, refunds, disputes and early
 * fraud warnings.
 */
import { createHash } from 'node:crypto';
import express, { type Request, type Response } from 'express';
import type { Clock } from '../../src/clock';
import { signStripeWebhook, STRIPE_VERSION } from '../../src/payments/stripe';

type Json = Record<string, unknown>;

interface Customer { id: string; email?: string; name?: string; address?: Json; shipping?: Json; metadata?: Json; deleted?: boolean }
interface Line { id: string; name: string; unit: number; quantity: number; tax: number; metadata: Json; taxCode?: string }
interface Session {
  id: string; status: 'open' | 'complete' | 'expired'; payment_status: 'paid' | 'unpaid';
  customer: string; lines: Line[]; shipping: { amount: number; tax: number; name: string };
  successUrl: string; cancelUrl: string; clientReferenceId?: string; metadata: Json; piMetadata: Json;
  expiresAt: number; created: number; customText?: string; automaticTax: boolean;
  paymentIntent?: string; params: Json;
}
interface Charge { id: string; pi: string; amount: number; refunded: number; risk?: string; fingerprint?: string; disputed?: boolean }
interface MockRefund { id: string; charge: string; amount: number; status: string; metadata: Json }
interface MockDispute { id: string; charge: string; status: string }
interface MockEfw { id: string; charge: string; actionable: boolean }

export interface MockStripeOptions {
  clock: Clock;
  /** Where the shop receives webhooks, e.g. http://127.0.0.1:8080/webhooks/stripe. */
  webhookTarget?: string;
  webhookSecret: string;
  /** Base of the checkout page URL handed to the browser (the shop passes /__mock-pages/* through in mock mode). */
  checkoutBase: string;
}

export interface PayOptions {
  /** Radar's risk level; undefined = absent (some wallets). */
  riskLevel?: 'normal' | 'elevated' | 'highest';
  fingerprint?: string;
}

/** Sales tax in the mock: Texas taxes shipping, New York doesn't, everywhere else none (14 §5). */
const TAX: Record<string, { rate: number; shipping: boolean }> = { TX: { rate: 0.0825, shipping: true }, NY: { rate: 0.08, shipping: false } };

const ALLOWED_SESSION_PARAMS = new Set([
  'mode', 'customer', 'client_reference_id', 'metadata', 'payment_intent_data', 'payment_method_types', 'line_items',
  'shipping_options', 'custom_text', 'billing_address_collection', 'automatic_tax', 'consent_collection',
  'allow_promotion_codes', 'expires_at', 'success_url', 'cancel_url', 'customer_update',
]);

export function createMockStripe(opts: MockStripeOptions) {
  const { clock } = opts;
  const s = {
    customers: new Map<string, Customer>(),
    sessions: new Map<string, Session>(),
    charges: new Map<string, Charge>(),
    idem: new Map<string, { hash: string; status: number; body: unknown }>(),
    n: 0,
    requests: [] as Array<{ method: string; path: string; body: unknown }>,
    deliveries: [] as Array<{ id: string; type: string; status: number | 'error' }>,
    paused: false,
    queued: [] as string[],
    dropNext: false,
    duplicateNext: false,
    oldShapeNext: false,
    refunds: new Map<string, MockRefund>(),
    disputes: new Map<string, MockDispute>(),
    efws: new Map<string, MockEfw>(),
    /** The next refund ends `failed` (refund.failed). */
    failNextRefund: false,
    /** The next refund stays `pending` until settled with settleRefund(). */
    pendingNextRefund: false,
  };
  const id = (prefix: string) => `${prefix}_mock_${String(++s.n).padStart(6, '0')}`;
  const now = () => Math.floor(clock.now() / 1000);

  const app = express();
  app.disable('x-powered-by');
  app.use(express.urlencoded({ extended: true, limit: '256kb' }));

  const fail = (res: Response, status: number, message: string, extra: Json = {}) =>
    res.status(status).json({ error: { message, type: 'invalid_request_error', ...extra } });

  // ---- control API ----
  app.post('/__mock/reset', (_req, res) => (reset(), res.json({ ok: true })));
  app.post('/__mock/stripe/sessions/:id/pay', async (req, res) => {
    const r = await pay(String(req.params.id), req.body as PayOptions);
    res.status(r ? 200 : 409).json({ ok: !!r });
  });
  app.post('/__mock/stripe/webhooks/:op', async (req, res) => {
    const op = String(req.params.op);
    if (op === 'pause') s.paused = true;
    else if (op === 'resume') {
      s.paused = false;
      for (const raw of s.queued.splice(0)) await deliver(raw);
    } else if (op === 'drop-next') s.dropNext = true;
    else if (op === 'duplicate-next') s.duplicateNext = true;
    else if (op === 'old-shape-next') s.oldShapeNext = true;
    else return res.status(404).end();
    res.json({ ok: true });
  });
  app.get('/__mock/requests', (_req, res) => res.json(s.requests));

  // ---- checkout page (the browser's side) ----
  app.get('/checkout/:id', (req, res) => {
    const ses = s.sessions.get(String(req.params.id));
    if (!ses) return res.status(404).type('text').send('no such session');
    const t = totals(ses);
    const esc = (x: string) => x.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Mock Stripe checkout</title><link rel="icon" href="data:,"></head><body><main>
<h1>Mock Stripe checkout</h1>
<p>Status: ${ses.status}</p>
<ul>${ses.lines.map((l) => `<li>${esc(l.name)} × ${l.quantity}: $${(l.unit * l.quantity / 100).toFixed(2)}</li>`).join('')}</ul>
<p>Shipping: $${(ses.shipping.amount / 100).toFixed(2)}</p><p>Tax: $${(t.tax / 100).toFixed(2)}</p><p>Total: $${(t.total / 100).toFixed(2)}</p>
${ses.customText ? `<p>${esc(ses.customText)}</p>` : ''}
<form method="post" action="./${ses.id}/pay"><button>Pay</button></form>
<form method="post" action="./${ses.id}/decline"><button>Decline</button></form>
<form method="post" action="./${ses.id}/cancel"><button>Cancel</button></form>
</main></body></html>`);
  });
  app.post('/checkout/:id/pay', async (req, res) => {
    const ses = await pay(String(req.params.id), { riskLevel: 'normal', fingerprint: 'fp_mock_card' });
    if (!ses) return res.status(409).type('text').send('this checkout is no longer open');
    res.redirect(303, ses.successUrl);
  });
  app.post('/checkout/:id/decline', (req, res) => res.status(402).type('html').send('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Declined</title></head><body><main><h1>Your card was declined</h1></main></body></html>'));
  app.post('/checkout/:id/cancel', (req, res) => {
    const ses = s.sessions.get(String(req.params.id));
    if (!ses) return res.status(404).end();
    res.redirect(303, ses.cancelUrl);
  });

  // ---- API: auth, version, idempotency ----
  app.use('/v1', (req, res, next) => {
    s.requests.push({ method: req.method, path: req.originalUrl, body: req.body });
    if (!/^Bearer mock_stripe_[A-Za-z0-9_-]+$/.test(req.get('authorization') ?? '')) {
      return res.status(401).json({ error: { message: 'Invalid API Key provided', type: 'invalid_request_error' } });
    }
    if (req.get('stripe-version') !== STRIPE_VERSION) return fail(res, 400, `mock: only Stripe-Version ${STRIPE_VERSION} is accepted`);
    const key = req.get('idempotency-key');
    if (key && req.method === 'POST') {
      const hash = createHash('sha256').update(JSON.stringify([req.path, req.body])).digest('hex');
      const prior = s.idem.get(key);
      if (prior) {
        if (prior.hash !== hash) {
          return res.status(400).json({ error: { message: 'Keys for idempotent requests can only be used with the same parameters they were first used with. Try using a key other than \'' + key + '\' if you meant to execute a different request.', type: 'idempotency_error' } });
        }
        return res.status(prior.status).json(prior.body);
      }
      const json = res.json.bind(res);
      res.json = (body: unknown) => {
        s.idem.set(key, { hash, status: res.statusCode, body });
        return json(body);
      };
    }
    next();
  });

  // ---- customers ----
  app.post('/v1/customers', (req, res) => {
    const b = req.body as Json;
    const c: Customer = { id: id('cus'), email: b.email as string, name: b.name as string, address: b.address as Json, shipping: b.shipping as Json, metadata: (b.metadata as Json) ?? {} };
    s.customers.set(c.id, c);
    res.json({ object: 'customer', ...c });
  });
  app.get('/v1/customers/:id', (req, res) => {
    const c = s.customers.get(String(req.params.id));
    if (!c) return fail(res, 404, `No such customer: '${req.params.id}'`, { code: 'resource_missing', param: 'id' });
    res.json({ object: 'customer', ...c });
  });
  app.delete('/v1/customers/:id', (req, res) => {
    const c = s.customers.get(String(req.params.id));
    if (!c) return fail(res, 404, `No such customer: '${req.params.id}'`, { code: 'resource_missing', param: 'id' });
    c.deleted = true;
    res.json({ id: c.id, object: 'customer', deleted: true });
  });

  // ---- checkout sessions ----
  app.post('/v1/checkout/sessions', (req, res) => {
    const b = req.body as Json;
    const unknown = Object.keys(b).find((k) => !ALLOWED_SESSION_PARAMS.has(k));
    if (unknown) return fail(res, 400, `Received unknown parameter: ${unknown}`, { param: unknown });
    if (b.mode !== 'payment') return fail(res, 400, 'mock: mode must be payment', { param: 'mode' });
    const customer = s.customers.get(String(b.customer ?? ''));
    if (!customer) return fail(res, 400, `No such customer: '${b.customer}'`, { param: 'customer', code: 'resource_missing' });
    const pmt = Object.values((b.payment_method_types as Json) ?? {});
    if (!pmt.length || pmt.some((p) => p !== 'card' && p !== 'link')) return fail(res, 400, 'mock: payment_method_types must be card and/or link', { param: 'payment_method_types' });
    const items = Object.values((b.line_items as Json) ?? {}) as Json[];
    if (!items.length) return fail(res, 400, 'Missing required param: line_items.', { param: 'line_items' });
    const state = String((customer.address as Json | undefined)?.state ?? '');
    const tax = b.automatic_tax && (b.automatic_tax as Json).enabled === 'true' ? TAX[state] : undefined;
    const lines: Line[] = [];
    for (const [i, it] of items.entries()) {
      const pd = (it.price_data ?? {}) as Json;
      const unit = Number(pd.unit_amount);
      if (!Number.isInteger(unit) || unit < 0) return fail(res, 400, 'Invalid non-negative integer', { param: `line_items[${i}][price_data][unit_amount]` });
      if (pd.currency !== 'usd') return fail(res, 400, 'mock: currency must be usd', { param: `line_items[${i}][price_data][currency]` });
      if (pd.tax_behavior !== 'exclusive') return fail(res, 400, 'mock: tax_behavior must be exclusive', { param: `line_items[${i}][price_data][tax_behavior]` });
      const qty = Number(it.quantity);
      if (!Number.isInteger(qty) || qty < 1) return fail(res, 400, 'mock: quantity must be a positive integer', { param: `line_items[${i}][quantity]` });
      const product = (pd.product_data ?? {}) as Json;
      if (!product.name) return fail(res, 400, 'Missing required param: line_items[0][price_data][product_data][name].');
      const amount = unit * qty;
      lines.push({ id: id('li'), name: String(product.name), unit, quantity: qty, tax: tax ? Math.round(amount * tax.rate) : 0, metadata: (product.metadata as Json) ?? {}, taxCode: product.tax_code as string });
    }
    const opts = Object.values((b.shipping_options as Json) ?? {}) as Json[];
    if (opts.length !== 1) return fail(res, 400, 'mock: the shop sends exactly one shipping option', { param: 'shipping_options' });
    const rate = (opts[0].shipping_rate_data ?? {}) as Json;
    const shipAmount = Number(((rate.fixed_amount ?? {}) as Json).amount);
    if (!Number.isInteger(shipAmount) || shipAmount < 0) return fail(res, 400, 'Invalid non-negative integer', { param: 'shipping_options[0][shipping_rate_data][fixed_amount][amount]' });
    const expiresAt = Number(b.expires_at ?? now() + 86400);
    if (expiresAt < now() + 1800 - 5 || expiresAt > now() + 86400) return fail(res, 400, 'The `expires_at` timestamp must be between 30 minutes and 24 hours from now.', { param: 'expires_at' });
    for (const k of ['success_url', 'cancel_url']) if (typeof b[k] !== 'string') return fail(res, 400, `Missing required param: ${k}.`, { param: k });
    const ses: Session = {
      id: id('cs'), status: 'open', payment_status: 'unpaid', customer: customer.id, lines,
      shipping: { amount: shipAmount, tax: tax?.shipping ? Math.round(shipAmount * tax.rate) : 0, name: String(rate.display_name ?? 'Shipping') },
      successUrl: String(b.success_url), cancelUrl: String(b.cancel_url), clientReferenceId: b.client_reference_id as string,
      metadata: (b.metadata as Json) ?? {}, piMetadata: (((b.payment_intent_data as Json) ?? {}).metadata as Json) ?? {},
      expiresAt, created: now(), customText: ((((b.custom_text as Json) ?? {}).submit as Json) ?? {}).message as string,
      automaticTax: !!tax || (b.automatic_tax as Json | undefined)?.enabled === 'true', params: b,
    };
    s.sessions.set(ses.id, ses);
    res.json(sessionBody(ses, false));
  });

  const session = (req: Request, res: Response): Session | undefined => {
    const ses = s.sessions.get(String(req.params.id));
    if (!ses) fail(res, 404, `No such checkout.session: ${req.params.id}`, { code: 'resource_missing' });
    return ses;
  };
  // The list, as the reverse sweep reads it: status and created[gte]; newest first.
  app.get('/v1/checkout/sessions', (req, res) => {
    const q = req.query as Record<string, unknown>;
    const gte = Number(q['created[gte]'] ?? (q.created as Record<string, unknown> | undefined)?.gte ?? 0);
    const list = [...s.sessions.values()]
      .filter((x) => (!q.status || x.status === q.status) && x.created >= gte)
      .sort((a, b) => b.created - a.created)
      .slice(0, Math.min(100, Number(q.limit ?? 10)));
    res.json({ object: 'list', data: list.map((x) => sessionBody(x, false)), has_more: false, url: '/v1/checkout/sessions' });
  });
  app.get('/v1/checkout/sessions/:id', (req, res) => {
    const ses = session(req, res);
    if (!ses) return;
    // Express 5 parses queries flat: `expand[]` stays a key of its own.
    const expand = ([] as unknown[]).concat((req.query.expand as unknown) ?? [], (req.query['expand[]'] as unknown) ?? []);
    res.json(sessionBody(ses, expand.includes('payment_intent.latest_charge') || expand.includes('payment_intent')));
  });
  app.get('/v1/checkout/sessions/:id/line_items', (req, res) => {
    const ses = session(req, res);
    if (!ses) return;
    const limit = Math.min(100, Number(req.query.limit ?? 10));
    const after = req.query.starting_after as string | undefined;
    const start = after ? ses.lines.findIndex((l) => l.id === after) + 1 : 0;
    const page = ses.lines.slice(start, start + limit);
    res.json({
      object: 'list', has_more: start + limit < ses.lines.length, url: `/v1/checkout/sessions/${ses.id}/line_items`,
      data: page.map((l) => ({
        id: l.id, object: 'item', quantity: l.quantity, amount_subtotal: l.unit * l.quantity, amount_tax: l.tax, amount_total: l.unit * l.quantity + l.tax,
        description: l.name, currency: 'usd',
        price: { id: `price_${l.id}`, unit_amount: l.unit, product: { id: `prod_${l.id}`, name: l.name, metadata: l.metadata, tax_code: l.taxCode ?? null } },
      })),
    });
  });
  app.post('/v1/checkout/sessions/:id/expire', async (req, res) => {
    const ses = session(req, res);
    if (!ses) return;
    if (ses.status !== 'open') return fail(res, 400, `Only Checkout Sessions with a status in [\"open\"] can be expired. This Checkout Session has a status of \"${ses.status}\".`);
    ses.status = 'expired';
    // The event goes out before the answer, so tests see it in order.
    await emit('checkout.session.expired', sessionBody(ses, false));
    res.json(sessionBody(ses, false));
  });


  // ---- charges, refunds, disputes, early fraud warnings (05 §4, §7) ----
  const chargeBody = (ch: Charge) => ({
    id: ch.id, object: 'charge', amount: ch.amount, amount_refunded: ch.refunded, refunded: ch.refunded >= ch.amount,
    payment_intent: ch.pi, disputed: !!ch.disputed, currency: 'usd',
    outcome: ch.risk ? { risk_level: ch.risk, type: 'authorized' } : null,
    payment_method_details: { type: 'card', card: ch.fingerprint ? { fingerprint: ch.fingerprint } : null },
  });
  const refundBody = (r: MockRefund) => ({ id: r.id, object: 'refund', amount: r.amount, charge: r.charge, currency: 'usd', status: r.status, metadata: r.metadata });
  app.get('/v1/charges/:id', (req, res) => {
    const ch = s.charges.get(String(req.params.id));
    if (!ch) return fail(res, 404, `No such charge: '${req.params.id}'`, { code: 'resource_missing', param: 'id' });
    res.json(chargeBody(ch));
  });
  app.post('/v1/refunds', async (req, res) => {
    const b = req.body as Json;
    const ch = [...s.charges.values()].find((c) => c.pi === b.payment_intent);
    if (!ch) return fail(res, 400, `No such payment_intent: '${String(b.payment_intent)}'`, { code: 'resource_missing', param: 'payment_intent' });
    if (ch.disputed) return fail(res, 400, `Charge ${ch.id} has been disputed.`, { code: 'charge_disputed' });
    const amount = b.amount === undefined ? ch.amount - ch.refunded : Number(b.amount);
    if (ch.refunded >= ch.amount) return fail(res, 400, `Charge ${ch.id} has already been refunded.`, { code: 'charge_already_refunded' });
    if (!Number.isInteger(amount) || amount <= 0 || amount > ch.amount - ch.refunded) return fail(res, 400, 'Refund amount is greater than unrefunded amount on charge', { code: 'amount_too_large', param: 'amount' });
    const status = s.failNextRefund ? 'failed' : s.pendingNextRefund ? 'pending' : 'succeeded';
    s.failNextRefund = s.pendingNextRefund = false;
    const r: MockRefund = { id: id('re'), charge: ch.id, amount, status, metadata: (b.metadata as Json) ?? {} };
    s.refunds.set(r.id, r);
    if (status !== 'failed') ch.refunded += amount;
    res.json(refundBody(r));
    if (status === 'succeeded') await emit('charge.refunded', chargeBody(ch));
    if (status === 'failed') await emit('refund.failed', refundBody(r));
  });
  app.get('/v1/refunds/:id', (req, res) => {
    const r = s.refunds.get(String(req.params.id));
    if (!r) return fail(res, 404, `No such refund: '${req.params.id}'`, { code: 'resource_missing', param: 'id' });
    res.json(refundBody(r));
  });
  app.get('/v1/disputes/:id', (req, res) => {
    const d = s.disputes.get(String(req.params.id));
    if (!d) return fail(res, 404, `No such dispute: '${req.params.id}'`, { code: 'resource_missing', param: 'id' });
    res.json({ id: d.id, object: 'dispute', charge: d.charge, status: d.status, amount: s.charges.get(d.charge)?.amount ?? 0, currency: 'usd' });
  });
  app.get('/v1/radar/early_fraud_warnings/:id', (req, res) => {
    const w = s.efws.get(String(req.params.id));
    if (!w) return fail(res, 404, `No such early fraud warning: '${req.params.id}'`, { code: 'resource_missing', param: 'id' });
    res.json({ id: w.id, object: 'radar.early_fraud_warning', charge: w.charge, actionable: w.actionable, fraud_type: 'made_with_stolen_card' });
  });
  app.use((req, res) => fail(res, 404, `mock: no route for ${req.method} ${req.path}`));

  // ---- behaviour ----
  function totals(ses: Session) {
    const subtotal = ses.lines.reduce((t, l) => t + l.unit * l.quantity, 0);
    const tax = ses.lines.reduce((t, l) => t + l.tax, 0) + ses.shipping.tax;
    return { subtotal, tax, total: subtotal + ses.shipping.amount + tax };
  }

  function sessionBody(ses: Session, expand: boolean): Json {
    const t = totals(ses);
    let pi: unknown = ses.paymentIntent ?? null;
    if (expand && ses.paymentIntent) {
      const ch = [...s.charges.values()].find((c) => c.pi === ses.paymentIntent)!;
      pi = {
        id: ses.paymentIntent, object: 'payment_intent', metadata: ses.piMetadata,
        latest_charge: {
          id: ch.id, object: 'charge', amount: ch.amount, amount_refunded: ch.refunded,
          outcome: ch.risk ? { risk_level: ch.risk, type: 'authorized' } : null,
          payment_method_details: { type: 'card', card: ch.fingerprint ? { fingerprint: ch.fingerprint } : null },
        },
      };
    }
    return {
      id: ses.id, object: 'checkout.session', mode: 'payment', status: ses.status, payment_status: ses.payment_status,
      url: ses.status === 'open' ? `${opts.checkoutBase}/${ses.id}` : null, currency: 'usd', customer: ses.customer,
      client_reference_id: ses.clientReferenceId ?? null, metadata: ses.metadata,
      amount_subtotal: t.subtotal, amount_total: t.total,
      total_details: { amount_discount: 0, amount_shipping: ses.shipping.amount, amount_tax: t.tax },
      shipping_cost: { amount_subtotal: ses.shipping.amount, amount_tax: ses.shipping.tax, amount_total: ses.shipping.amount + ses.shipping.tax, shipping_rate: `shr_${ses.id}` },
      automatic_tax: { enabled: ses.automaticTax, status: ses.automaticTax ? 'complete' : null },
      payment_intent: pi, expires_at: ses.expiresAt, created: ses.created, livemode: false,
    };
  }

  async function pay(sessionId: string, p: PayOptions = {}): Promise<Session | undefined> {
    const ses = s.sessions.get(sessionId);
    if (!ses || ses.status !== 'open') return undefined;
    ses.status = 'complete';
    ses.payment_status = 'paid';
    ses.paymentIntent = id('pi');
    const ch: Charge = { id: id('ch'), pi: ses.paymentIntent, amount: totals(ses).total, refunded: 0, risk: p.riskLevel, fingerprint: p.fingerprint };
    s.charges.set(ch.id, ch);
    await emit('checkout.session.completed', sessionBody(ses, false));
    return ses;
  }

  async function emit(type: string, object: Json) {
    const event = s.oldShapeNext
      // A 2017-04-06 shaped payload: the shop must use only id, type and data.object.id (review 1 F12).
      ? { id: id('evt'), object: 'event', api_version: '2017-04-06', created: now(), type, data: { object: { id: object.id, object: object.object } } }
      : { id: id('evt'), object: 'event', api_version: STRIPE_VERSION, created: now(), type, livemode: false, pending_webhooks: 1, data: { object } };
    s.oldShapeNext = false;
    const raw = JSON.stringify(event);
    if (s.dropNext) {
      s.dropNext = false;
      s.deliveries.push({ id: event.id, type, status: 'error' });
      return;
    }
    if (s.paused) return void s.queued.push(raw);
    await deliver(raw);
    if (s.duplicateNext) {
      s.duplicateNext = false;
      await deliver(raw);
    }
  }

  async function deliver(raw: string) {
    const ev = JSON.parse(raw) as { id: string; type: string };
    if (!opts.webhookTarget) return void s.deliveries.push({ id: ev.id, type: ev.type, status: 'error' });
    try {
      const res = await fetch(opts.webhookTarget, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'stripe-signature': signStripeWebhook(raw, opts.webhookSecret, clock.now()) },
        body: raw,
      });
      s.deliveries.push({ id: ev.id, type: ev.type, status: res.status });
    } catch {
      s.deliveries.push({ id: ev.id, type: ev.type, status: 'error' });
    }
  }

  function reset() {
    s.customers.clear(); s.sessions.clear(); s.charges.clear(); s.idem.clear();
    s.requests.length = 0; s.deliveries.length = 0; s.queued.length = 0;
    s.paused = s.dropNext = s.duplicateNext = s.oldShapeNext = false;
    s.refunds.clear(); s.disputes.clear(); s.efws.clear();
    s.failNextRefund = s.pendingNextRefund = false;
  }

  return {
    app, reset, pay,
    expire: async (sessionId: string) => {
      const ses = s.sessions.get(sessionId);
      if (ses?.status === 'open') {
        ses.status = 'expired';
        await emit('checkout.session.expired', sessionBody(ses, false));
      }
    },
    /** A refund made in the Stripe Dashboard (partial or full). */
    dashboardRefund: async (chargeId: string, amount: number) => {
      const ch = s.charges.get(chargeId)!;
      const r: MockRefund = { id: id('re'), charge: ch.id, amount, status: 'succeeded', metadata: {} };
      s.refunds.set(r.id, r);
      ch.refunded += amount;
      await emit('charge.refunded', chargeBody(ch));
      return r.id;
    },
    settleRefund: async (refundId: string, status: 'succeeded' | 'failed') => {
      const r = s.refunds.get(refundId)!;
      const ch = s.charges.get(r.charge)!;
      if (status === 'failed' && r.status === 'pending') ch.refunded -= r.amount;
      r.status = status;
      await emit(status === 'failed' ? 'refund.failed' : 'refund.updated', refundBody(r));
      if (status === 'succeeded') await emit('charge.refunded', chargeBody(ch));
    },
    earlyFraudWarning: async (chargeId: string) => {
      const w: MockEfw = { id: id('issfr'), charge: chargeId, actionable: true };
      s.efws.set(w.id, w);
      await emit('radar.early_fraud_warning.created', { id: w.id, object: 'radar.early_fraud_warning', charge: chargeId, actionable: true });
      return w.id;
    },
    dispute: async (chargeId: string) => {
      const d: MockDispute = { id: id('dp'), charge: chargeId, status: 'needs_response' };
      s.disputes.set(d.id, d);
      s.charges.get(chargeId)!.disputed = true;
      await emit('charge.dispute.created', { id: d.id, object: 'dispute', charge: chargeId, status: d.status });
      return d.id;
    },
    closeDispute: async (disputeId: string, outcome: 'won' | 'lost') => {
      const d = s.disputes.get(disputeId)!;
      d.status = outcome;
      await emit('charge.dispute.closed', { id: d.id, object: 'dispute', charge: d.charge, status: outcome });
    },
    sessions: s.sessions, customers: s.customers, requests: s.requests, deliveries: s.deliveries, charges: s.charges, refunds: s.refunds,
    control: s,
  };
}

export type MockStripe = ReturnType<typeof createMockStripe>;
