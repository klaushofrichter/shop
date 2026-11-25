import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PrintfulClient } from '../src/providers/printful';
import { QUIET_PERIOD_MS, submitOrder, type SubmitDeps } from '../src/orders/submit';
import { paidOrder, startHarness, type Harness } from './helpers/harness';

// docs/design/06 §4, 07 §2.3–2.4, 12 §1: submission against mock Printful
// over HTTP, with the real job runner and a fake clock.

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(() => h.close());

const order = (id: string) => h.shop.dbs.orders.prepare('SELECT * FROM orders WHERE id = ?').get(id) as Record<string, any>;
const attempts = (id: string) => h.shop.dbs.orders.prepare('SELECT * FROM provider_orders WHERE order_id = ? ORDER BY attempt').all(id) as Array<Record<string, any>>;
const holds = (id: string) => h.shop.dbs.orders.prepare('SELECT kind, reasons_json, deadline_action FROM holds WHERE order_id = ? AND resolved_at IS NULL').all(id) as Array<Record<string, any>>;
const pfOrders = () => [...h.printful.orders.values()];
const pfRequests = (method: string, re: RegExp) => h.printful.requests.filter((r) => r.method === method && re.test(r.path));
/** Run the runner until nothing is due, moving the clock as far as each wait. */
async function settle(maxSteps = 20) {
  for (let i = 0; i < maxSteps; i++) {
    if ((await h.shop.runner.tick()) === 0) {
      const next = h.shop.dbs.orders.prepare("SELECT MIN(run_after) t FROM jobs WHERE state = 'queued' AND kind = 'order.submit'").get() as { t: string | null };
      if (!next.t) return;
      h.clock.advance(Math.max(0, Date.parse(next.t) - h.clock.now()) + 1);
    }
  }
}

describe('submission (06 §4)', () => {
  it('creates the draft, waits for costs, confirms: one Printful order, submitted', async () => {
    const id = await paidOrder(h);
    await settle();
    const o = order(id);
    expect(o.fulfilment_state).toBe('submitted');
    expect(attempts(id)).toMatchObject([{ attempt: 1, external_id: `${id}-1`, state: 'confirmed', confirm_tries: 1 }]);
    expect(pfOrders()).toHaveLength(1);
    expect(pfOrders()[0]).toMatchObject({ externalId: `${id}-1`, status: 'pending' });
    const body = pfRequests('POST', /^\/v2\/orders$/)[0].body as Record<string, any>;
    // ADR-0031: name and address only; the shop's contact on the slip.
    expect(body.recipient).toEqual({ name: 'Jane Doe', address1: '1 Main St', city: 'Austin', state_code: 'TX', zip: '78701', country_code: 'US' });
    expect(body.customization.packing_slip).toEqual({ store_name: 'localhost:8080', custom_order_id: o.number, email: 'orders@example.com', phone: '+1 555 010 0000' });
    expect(body.order_items[0]).toMatchObject({
      source: 'catalog', catalog_variant_id: 4463, external_id: `${id}-1`, quantity: 1, retail_price: '32.00', orientation: 'vertical',
      placements: [{ placement: 'default', technique: 'digital', layers: [{ type: 'file', url: expect.stringMatching(/\/files\/print-8x100+\.jpg$/) }] }],
    });
    expect(body.retail_costs).toMatchObject({ currency: 'USD', shipping: (o.shipping_cents / 100).toFixed(2) });
    expect(JSON.stringify(body)).not.toContain('jane@example.com');
    const ev = h.shop.dbs.orders.prepare("SELECT to_value FROM order_events WHERE order_id = ? AND part = 'fulfilment' ORDER BY id").all(id).map((r: any) => r.to_value);
    expect(ev).toEqual(['submitting', 'draft', 'confirming', 'submitted']);
  });

  it('a lost create answer: the next run looks up and adopts, never a second order', async () => {
    h.printful.scenario({ loseNextCreateAnswer: true });
    const id = await paidOrder(h);
    await settle();
    expect(pfOrders()).toHaveLength(1);
    expect(pfRequests('POST', /^\/v2\/orders$/)).toHaveLength(1);
    expect(order(id).fulfilment_state).toBe('submitted');
  });

  it('a lost confirm answer: stays confirming, read back after the quiet period, confirmed once', async () => {
    h.printful.scenario({ loseNextConfirmAnswer: true });
    const id = await paidOrder(h);
    await h.shop.runner.tick();
    h.clock.advance(5_000);
    await h.shop.runner.tick();
    expect(order(id).fulfilment_state).toBe('confirming');
    h.clock.advance(QUIET_PERIOD_MS - 10_000);
    await h.shop.runner.tick();
    expect(order(id).fulfilment_state).toBe('confirming'); // still quiet
    await settle();
    expect(order(id).fulfilment_state).toBe('submitted');
    expect(pfRequests('POST', /\/confirmation$/)).toHaveLength(1);
  });

  it('a refused order: a provider_refused hold that refunds, nothing confirmed', async () => {
    h.printful.scenario({ refuseNextOrder: true });
    const id = await paidOrder(h);
    await settle();
    expect(holds(id)).toEqual([{ kind: 'attention', reasons_json: '["provider_refused"]', deadline_action: 'refund' }]);
    expect(pfOrders()).toHaveLength(0);
    expect(attempts(id)[0].last_error).toMatch(/Recipient/);
  });

  it('the cost guard holds the draft when Printful costs more than the order allows', async () => {
    h.printful.scenario({ costFactor: 10 });
    const id = await paidOrder(h);
    await settle();
    expect(holds(id)).toEqual([{ kind: 'attention', reasons_json: '["cost_guard"]', deadline_action: 'refund' }]);
    expect(pfOrders()[0].status).toBe('draft');
    expect(order(id).fulfilment_state).toBe('draft');
    expect(pfRequests('POST', /\/confirmation$/)).toHaveLength(0);
  });

  it('costs that fail: an attention hold', async () => {
    h.printful.scenario({ failCosts: true });
    const id = await paidOrder(h);
    await settle();
    expect(holds(id)[0].reasons_json).toBe('["costs_failed"]');
  });

  it('a full refund at Stripe before the confirm blocks it (I2, I3); a partial one does not (review F3)', async () => {
    const id = await paidOrder(h);
    await h.shop.runner.tick();
    for (const ch of h.stripe.control.charges.values()) ch.refunded = ch.amount;
    h.clock.advance(5_000);
    await settle();
    expect(pfRequests('POST', /\/confirmation$/)).toHaveLength(0);
    expect(holds(id)[0].reasons_json).toBe('["fulfilment_blocked"]');

    const b = await paidOrder(h);
    await h.shop.runner.tick();
    const charge = [...h.stripe.control.charges.values()].find((c) => c.pi === order(b).stripe_payment_intent)!;
    charge.refunded = 300; // goodwill in the Dashboard
    h.clock.advance(5_000);
    await settle();
    expect(order(b).fulfilment_state).toBe('submitted');
  });


  it('an order on hold is not submitted; I2 is checked before the claim', async () => {
    const id = await paidOrder(h);
    h.shop.dbs.orders.prepare("INSERT INTO holds (order_id, kind, reasons_json, since, deadline_at, deadline_action) VALUES (?, 'approval', '[\"amount\"]', 'x', 'y', 'refund')").run(id);
    await settle();
    expect(attempts(id)).toEqual([]);
    expect(pfOrders()).toHaveLength(0);
  });

  it('test mode stops at the draft: no confirm method, test_draft_ok, complete', async () => {
    const id = await paidOrder(h);
    const s = h.shop;
    const testProvider = new PrintfulClient({ baseUrl: s.config.printful.baseUrl, token: s.config.printful.token! });
    expect(testProvider.confirm).toBeUndefined();
    const deps: SubmitDeps = {
      orders: s.dbs.orders, catalog: s.dbs.catalog, clock: h.clock, provider: testProvider, stripe: undefined as never, mode: 'test',
      publicUrl: s.config.publicUrl, skus: s.skus, quote: s.config.quote, fulfilment: s.config.fulfilment, log: () => {},
    };
    await expect(submitOrder(deps, id)).rejects.toThrow(/costs calculating/);
    h.clock.advance(5_000);
    expect(await submitOrder(deps, id)).toBe('test_draft_ok');
    expect(order(id)).toMatchObject({ fulfilment_state: 'test_draft_ok', completed_at: expect.any(String) });
    expect(pfOrders()[0].status).toBe('draft');
    expect(await submitOrder(deps, id)).toBe('not_needed');
  });
});
