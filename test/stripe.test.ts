import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMockStripe, type MockStripe } from '../mocks/stripe/server';
import { FakeClock } from '../src/clock';
import { encodeForm, signStripeWebhook, StripeClient, STRIPE_VERSION, verifyStripeWebhook } from '../src/payments/stripe';

const SECRET = 'whsec_mock_0001';
const clock = new FakeClock(Date.UTC(2026, 10, 26, 12));
let mock: MockStripe;
let server: Server;
let hook: Server;
let base: string;
const received: Array<{ raw: Buffer; signature: string | undefined }> = [];

beforeAll(async () => {
  hook = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({ raw: Buffer.concat(chunks), signature: req.headers['stripe-signature'] as string | undefined });
      res.end('ok');
    });
  }).listen(0);
  await new Promise((r) => hook.once('listening', r));
  mock = createMockStripe({ clock, webhookSecret: SECRET, checkoutBase: 'https://shop.example.com/__mock-pages/stripe/checkout', webhookTarget: `http://127.0.0.1:${(hook.address() as AddressInfo).port}/` });
  server = mock.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
  hook.close();
});
beforeEach(() => {
  mock.reset();
  received.length = 0;
});

const stripe = () => new StripeClient({ apiBase: base, secretKey: 'mock_stripe_1', timeoutMs: 2000 });

function sessionParams(customer: string, lines = 1, over: Record<string, unknown> = {}) {
  return {
    mode: 'payment', customer, client_reference_id: 'ord1', metadata: { order_id: 'ord1' },
    payment_intent_data: { metadata: { order_id: 'ord1' }, description: 'Order 48213' },
    allowed_payment_method_types: ['card'],
    line_items: Array.from({ length: lines }, (_, i) => ({
      quantity: 1,
      price_data: { currency: 'usd', unit_amount: 1000, tax_behavior: 'exclusive', product_data: { name: `Item ${i}`, tax_code: 'txcd_99999999', metadata: { order_item_id: `oi${i}` } } },
    })),
    shipping_options: [{ shipping_rate_data: { type: 'fixed_amount', fixed_amount: { amount: 500, currency: 'usd' }, display_name: 'Standard', tax_behavior: 'exclusive', tax_code: 'txcd_92010001' } }],
    automatic_tax: { enabled: true },
    expires_at: Math.floor(clock.now() / 1000) + 1800,
    success_url: 'https://shop.example.com/order/ord1?t=x', cancel_url: 'https://shop.example.com/cart',
    ...over,
  };
}

describe('form encoding and webhook signatures', () => {
  it('encodes nested objects and arrays with brackets', () => {
    expect(encodeForm({ a: 1, b: { c: 'x y', d: [true, null] }, e: undefined })).toEqual(['a=1', 'b%5Bc%5D=x%20y', 'b%5Bd%5D%5B0%5D=true', 'b%5Bd%5D%5B1%5D=']);
  });

  it('verifies the signature and uses only id, type and data.object.id', () => {
    const raw = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: 'cs_1', amount_total: 999 } } });
    const sig = signStripeWebhook(raw, SECRET, clock.now());
    expect(verifyStripeWebhook(Buffer.from(raw), sig, SECRET, clock.now())).toEqual({ id: 'evt_1', type: 'checkout.session.completed', objectId: 'cs_1' });
    expect(verifyStripeWebhook(Buffer.from(raw.replace('999', '1')), sig, SECRET, clock.now())).toBeUndefined();
    expect(verifyStripeWebhook(Buffer.from(raw), sig, 'whsec_other', clock.now())).toBeUndefined();
    expect(verifyStripeWebhook(Buffer.from(raw), sig, SECRET, clock.now() + 301_000)).toBeUndefined();
    expect(verifyStripeWebhook(Buffer.from(raw), undefined, SECRET, clock.now())).toBeUndefined();
  });
});

describe('the client against mock Stripe', () => {
  it('creates a customer and a session; tax per the mock table (Texas taxes shipping)', async () => {
    const c = await stripe().createCustomer({ email: 'jane@example.com', name: 'Jane', address: { line1: '1 Main', city: 'Austin', state: 'TX', postal_code: '78701', country: 'US' } }, 'customer-ord1');
    const ses = await stripe().createCheckoutSession(sessionParams(c.id), 'checkout-ord1');
    expect(ses).toMatchObject({ status: 'open', amount_subtotal: 1000, url: `https://shop.example.com/__mock-pages/stripe/checkout/${ses.id}` });
    expect(ses.total_details?.amount_tax).toBe(83 + 41); // 8.25 % of 10.00 and of 5.00
    expect(ses.shipping_cost).toMatchObject({ amount_subtotal: 500, amount_tax: 41, amount_total: 541 });
    expect(mock.requests.at(-1)).toMatchObject({ method: 'POST', path: '/v1/checkout/sessions' });
  });

  it('replays an idempotent create; refuses the same key with other parameters (captured message)', async () => {
    const c = await stripe().createCustomer({ email: 'a@example.com' }, 'k1');
    const a = await stripe().createCheckoutSession(sessionParams(c.id), 'k2');
    const b = await stripe().createCheckoutSession(sessionParams(c.id), 'k2');
    expect(b.id).toBe(a.id);
    await expect(stripe().createCheckoutSession(sessionParams(c.id, 1, { client_reference_id: 'other' }), 'k2')).rejects.toMatchObject({
      kind: 'idempotency',
      message: expect.stringContaining('Keys for idempotent requests can only be used with the same parameters'),
    });
  });

  it('refuses unknown parameters, negative amounts and other API versions', async () => {
    const c = await stripe().createCustomer({}, 'k3');
    await expect(stripe().createCheckoutSession(sessionParams(c.id, 1, { shipping_adress_collection: 'x' }), 'k4')).rejects.toMatchObject({ kind: 'permanent', param: 'shipping_adress_collection' });
    // Automatic tax with a PaymentIntent shipping address: refused (cluster test mode, 2026-11-25).
    await expect(
      stripe().createCheckoutSession(sessionParams(c.id, 1, { automatic_tax: { enabled: true }, payment_intent_data: { shipping: { name: 'J', address: { line1: '1 Main St', city: 'Austin', state: 'TX', postal_code: '78701', country: 'US' } } } }), 'k4c'),
    ).rejects.toMatchObject({ kind: 'permanent', message: 'stripe: You cannot enable automatic tax calculation with `payment_intent_data[shipping]` set.' });
    // Removed in the pinned version (cluster test mode, 2026-11-25): Stripe answers 400 with this param.
    await expect(stripe().createCheckoutSession(sessionParams(c.id, 1, { payment_method_types: ['card'] }), 'k4b')).rejects.toMatchObject({ kind: 'permanent', param: 'payment_method_types' });
    const neg = sessionParams(c.id);
    (neg.line_items[0].price_data as { unit_amount: number }).unit_amount = -1;
    await expect(stripe().createCheckoutSession(neg, 'k5')).rejects.toMatchObject({ message: 'stripe: Invalid non-negative integer', param: 'line_items[0][price_data][unit_amount]' });
    const res = await fetch(`${base}/v1/customers`, { method: 'POST', headers: { authorization: 'Bearer mock_stripe_1', 'stripe-version': '2017-04-06' } });
    expect(res.status).toBe(400);
    expect(STRIPE_VERSION).toBe('2026-11-18.endive');
  });

  it('pays: a signed checkout.session.completed reaches the shop; the session expands to the charge', async () => {
    const c = await stripe().createCustomer({}, 'k6');
    const ses = await stripe().createCheckoutSession(sessionParams(c.id), 'k7');
    await mock.pay(ses.id, { riskLevel: 'elevated', fingerprint: 'fp1' });
    expect(received).toHaveLength(1);
    const ev = verifyStripeWebhook(received[0].raw, received[0].signature, SECRET, clock.now());
    expect(ev).toEqual({ id: expect.stringMatching(/^evt_mock_/), type: 'checkout.session.completed', objectId: ses.id });
    const paid = await stripe().getCheckoutSession(ses.id, true);
    expect(paid).toMatchObject({ status: 'complete', payment_status: 'paid', url: null });
    const pi = paid.payment_intent as { latest_charge: { amount: number; outcome: { risk_level: string }; payment_method_details: { card: { fingerprint: string } } } };
    expect(pi.latest_charge).toMatchObject({ amount: paid.amount_total, outcome: { risk_level: 'elevated' }, payment_method_details: { card: { fingerprint: 'fp1' } } });
  });

  it('pages line items past 100 and finds each order item id', async () => {
    const c = await stripe().createCustomer({}, 'k8');
    const ses = await stripe().createCheckoutSession(sessionParams(c.id, 105), 'k9');
    const lines = await stripe().listLineItems(ses.id);
    expect(lines).toHaveLength(105);
    expect(lines[104].orderItemId).toBe('oi104');
    expect(mock.requests.filter((r) => r.path.includes('/line_items'))).toHaveLength(2);
  });

  it('expires an open session (and says so by webhook); refuses a complete one', async () => {
    const c = await stripe().createCustomer({}, 'k10');
    const open = await stripe().createCheckoutSession(sessionParams(c.id), 'k11');
    expect((await stripe().expireCheckoutSession(open.id)).status).toBe('expired');
    expect(JSON.parse(received.at(-1)!.raw.toString()).type).toBe('checkout.session.expired');
    const paid = await stripe().createCheckoutSession(sessionParams(c.id, 2), 'k12');
    await mock.pay(paid.id);
    await expect(stripe().expireCheckoutSession(paid.id)).rejects.toMatchObject({ kind: 'permanent', status: 400 });
  });

  it('a 2017-shaped event still verifies to the three fields', async () => {
    const c = await stripe().createCustomer({}, 'k13');
    const ses = await stripe().createCheckoutSession(sessionParams(c.id), 'k14');
    mock.control.oldShapeNext = true;
    await mock.pay(ses.id);
    const body = JSON.parse(received[0].raw.toString());
    expect(body.api_version).toBe('2017-04-06');
    expect(verifyStripeWebhook(received[0].raw, received[0].signature, SECRET, clock.now())).toMatchObject({ objectId: ses.id });
  });
});
