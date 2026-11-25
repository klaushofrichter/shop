import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { csrfToken, SESSION_COOKIE, signSession } from '../src/admin/session';
import { paidOrder, startHarness, type Harness } from './helpers/harness';

// docs/design/08 §3: the admin's orders and Klaus's actions, against the
// real shop with mock Stripe and mock Printful.

const ADMIN = 'admin@example.com';
let h: Harness;
let cookie: string;
let csrf: string;
beforeEach(async () => {
  h = await startHarness({ ALLOWED_EMAILS: ADMIN, APPROVAL_OVER_CENTS: '1000' }); // every order over $10 needs approval
  const session = { email: ADMIN, exp: h.clock.now() + 3_600_000 };
  cookie = `${SESSION_COOKIE}=${signSession('c'.repeat(40), session)}`;
  csrf = csrfToken('c'.repeat(40), session);
});
afterEach(() => h.close());

const db = () => h.shop.dbs.orders;
const order = (id: string) => db().prepare('SELECT * FROM orders WHERE id = ?').get(id) as Record<string, any>;
const holdId = (id: string) => (db().prepare('SELECT id FROM holds WHERE order_id = ? AND resolved_at IS NULL').get(id) as { id: number }).id;
const get = (p: string) => fetch(h.shopUrl + p, { headers: { cookie }, redirect: 'manual' });
const post = (p: string, form: Record<string, string> = { sure: 'on' }) =>
  fetch(h.shopUrl + p, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', origin: 'http://localhost:8080' },
    body: new URLSearchParams({ _csrf: csrf, ...form }).toString(),
  });
async function settle() {
  for (let i = 0; i < 30; i++) {
    if ((await h.shop.runner.tick()) > 1) continue;
    const next = db().prepare("SELECT MIN(run_after) t FROM jobs WHERE state = 'queued' AND kind NOT IN ('holds.deadlines', 'catalog.check', 'printful.verify')").get() as { t: string | null };
    if (!next.t || Date.parse(next.t) - h.clock.now() > 10 * 60_000) return;
    h.clock.advance(Math.max(0, Date.parse(next.t) - h.clock.now()) + 1);
  }
}

describe('admin orders (08 §3)', () => {
  it('the dashboard lists the open hold; the order page shows it with Approve', async () => {
    const id = await paidOrder(h);
    const dash = await (await get('/admin')).text();
    expect(dash).toContain(`Order ${order(id).number}</a>: approval hold, large amount; refunds automatically in 3 days`);
    const list = await (await get(`/admin/orders?q=${order(id).number}`)).text();
    expect(list).toContain('1 open');
    const page = await (await get(`/admin/orders/${id}`)).text();
    expect(page).toContain('Approve and fulfil');
    expect(page).toContain("I'm sure");
    expect((await get('/admin/orders/notanid')).status).toBe(404);
  });

  it('Approve needs "I\'m sure", resolves the hold once, and the order goes to Printful', async () => {
    const id = await paidOrder(h);
    const hid = holdId(id);
    expect((await post(`/admin/orders/${id}/holds/${hid}/approve`, {})).status).toBe(400);
    expect((await post(`/admin/orders/${id}/holds/${hid}/approve`)).status).toBe(303);
    expect((await post(`/admin/orders/${id}/holds/${hid}/approve`)).status).toBe(409); // only the first wins
    await settle();
    expect(order(id).fulfilment_state).toBe('submitted');
    const audit = db().prepare("SELECT actor, action FROM admin_audit WHERE target = ? ORDER BY id").all(id);
    expect(audit).toEqual([
      { actor: ADMIN, action: 'order.approve' },
      { actor: ADMIN, action: 'order.approve' },
    ]);
  });

  it('a cross-site POST is refused', async () => {
    const id = await paidOrder(h);
    const res = await fetch(`${h.shopUrl}/admin/orders/${id}/refund`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' },
      body: new URLSearchParams({ _csrf: csrf, sure: 'on' }).toString(),
    });
    expect(res.status).toBe(403);
  });

  it('Refund in full: refunded, the hold resolved, complete', async () => {
    const id = await paidOrder(h);
    expect((await post(`/admin/orders/${id}/refund`)).status).toBe(303);
    await settle();
    expect(order(id)).toMatchObject({ payment_state: 'refunded', completed_at: expect.any(String) });
    expect(db().prepare('SELECT resolution FROM holds WHERE order_id = ?').get(id)).toEqual({ resolution: 'refunded' });
    expect((await post(`/admin/orders/${id}/refund`)).status).toBe(409);
  });

  it('Confirm anyway after a cost-guard hold confirms that attempt without the guard', async () => {
    const h2 = h;
    h2.printful.scenario({ costFactor: 10 });
    const id = await paidOrder(h2);
    await post(`/admin/orders/${id}/holds/${holdId(id)}/approve`);
    await settle();
    expect(db().prepare('SELECT reasons_json FROM holds WHERE order_id = ? AND resolved_at IS NULL').get(id)).toEqual({ reasons_json: '["cost_guard"]' });
    expect((await post(`/admin/orders/${id}/holds/${holdId(id)}/confirm-anyway`)).status).toBe(303);
    await settle();
    expect(order(id).fulfilment_state).toBe('submitted');
    expect(db().prepare('SELECT override_by FROM provider_orders WHERE order_id = ?').get(id)).toEqual({ override_by: ADMIN });
  });

  it('Retry submission after Printful cancelled: attempt 2, at most 3', async () => {
    const id = await paidOrder(h);
    await post(`/admin/orders/${id}/holds/${holdId(id)}/approve`);
    await settle();
    expect((await post(`/admin/orders/${id}/retry`)).status).toBe(409); // attempt 1 is live
    const pf = [...h.printful.orders.values()].find((o) => o.externalId === `${id}-1`)!;
    await h.printful.advance(pf.id, 'canceled');
    await settle();
    // A Printful cancel opens a hold that refunds at once; Klaus retries first here, before the sweep runs.
    expect((await post(`/admin/orders/${id}/retry`)).status).toBe(303);
    await settle();
    expect(db().prepare('SELECT attempt, state FROM provider_orders WHERE order_id = ? ORDER BY attempt').all(id)).toEqual([
      { attempt: 1, state: 'canceled' },
      { attempt: 2, state: 'confirmed' },
    ]);
    expect(order(id).fulfilment_state).toBe('submitted');
  });

  it('Reset the circuit breaker releases holds whose only reason is the breaker', async () => {
    const id = await paidOrder(h);
    db().prepare('UPDATE holds SET reasons_json = \'["breaker"]\' WHERE order_id = ?').run(id);
    expect((await post('/admin/breaker/reset')).status).toBe(303);
    expect(db().prepare('SELECT resolution FROM holds WHERE order_id = ?').get(id)).toEqual({ resolution: 'released' });
    await settle();
    expect(order(id).fulfilment_state).toBe('submitted');
  });
});
