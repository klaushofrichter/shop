import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, ConfigError } from '../src/config';
import { alertingLog } from '../src/email/jobs';
import { signV4 } from '../src/email/ses';
import { openHold } from '../src/orders/holds';
import { requestFullRefund } from '../src/orders/refunds';
import { paidOrder, startHarness, visitor, type Harness } from './helpers/harness';

// docs/design/09: customer e-mails and alerts through SES (mock), ADR-0038.

describe('SigV4', () => {
  it('matches the AWS test suite (get-vanilla)', () => {
    const auth = signV4({
      method: 'GET', path: '/', body: '', amzDate: '20150830T123600Z',
      headers: { host: 'example.amazonaws.com', 'x-amz-date': '20150830T123600Z' },
      region: 'us-east-1', service: 'service', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    });
    expect(auth).toBe('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
  });
});

describe('e-mail configuration', () => {
  const problems = (env: Record<string, string>) => {
    try {
      loadConfig(env);
      return [];
    } catch (e) {
      return (e as ConfigError).problems;
    }
  };
  it('mock mode takes mock SES keys and a local endpoint only; EMAIL_ENABLED needs keys', () => {
    expect(problems({ SHOP_SES_AWS_ACCESS_KEY_ID: 'AKIAREAL', SHOP_SES_AWS_SECRET_ACCESS_KEY: 'x', SES_ENDPOINT: 'http://localhost:1' }).join()).toMatch(/mock_ses_/);
    expect(problems({ SHOP_SES_AWS_ACCESS_KEY_ID: 'mock_ses_1', SHOP_SES_AWS_SECRET_ACCESS_KEY: 'x' }).join()).toMatch(/SES_ENDPOINT/);
    expect(problems({ EMAIL_ENABLED: 'on' }).join()).toMatch(/needs the SES keys/);
    expect(problems({ ALERT_EMAIL: 'nope' }).join()).toMatch(/ALERT_EMAIL/);
  });
});

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(() => h.close());

const db = () => h.shop.dbs.orders;
const order = (id: string) => db().prepare('SELECT * FROM orders WHERE id = ?').get(id) as Record<string, any>;
const toCustomer = () => h.ses.sent.filter((m) => m.to.includes('jane@example.com'));
const alerts = () => h.ses.sent.filter((m) => m.to.includes('alerts@example.com'));
async function settle() {
  for (let i = 0; i < 40; i++) {
    if ((await h.shop.runner.tick()) > 1) continue;
    const next = db().prepare("SELECT MIN(run_after) t FROM jobs WHERE state = 'queued' AND kind IN ('order.submit', 'printful.event', 'stripe.event', 'refund.run', 'order.cancel', 'email.send', 'alert.send')").get() as { t: string | null };
    if (!next.t || Date.parse(next.t) - h.clock.now() > 10 * 60_000) return;
    h.clock.advance(Math.max(0, Date.parse(next.t) - h.clock.now()) + 1);
  }
}

describe('customer e-mails (09 §1)', () => {
  it('the confirmation: once, from the orders address, the status link, feedback to the bounce address, HTML and text', async () => {
    const id = await paidOrder(h);
    await settle();
    await settle();
    const mails = toCustomer().filter((m) => m.subject.startsWith('Your order'));
    expect(mails).toHaveLength(1);
    const m = mails[0];
    expect(m.from).toBe('localhost:8080 <orders@example.com>');
    expect(m.feedbackTo).toBe('bounces@example.com');
    expect(m.subject).toBe(`Your order ${order(id).number}`);
    expect(m.text).toContain(`See your order (http://localhost:8080/order/${id}?t=`);
    expect(m.text).toContain('Ships to Jane Doe, Austin, TX.');
    expect(m.text).not.toContain('1 Main St'); // city and state only
    expect(m.html).toContain('<html lang="en">');
    expect(m.html).not.toMatch(/<img|<script/);
    expect(db().prepare("SELECT sent_at FROM emails WHERE order_id = ? AND kind = 'confirmation'").get(id)).toEqual({ sent_at: expect.any(String) });
  });

  it('shipped: one per parcel, with tracking and its items', async () => {
    const id = await paidOrder(h);
    await settle();
    const pf = [...h.printful.orders.values()][0];
    await h.printful.ship(pf.id);
    await settle();
    const m = toCustomer().find((x) => x.subject.startsWith('Shipped'))!;
    expect(m.text).toContain('with USPS (USPS Ground Advantage)');
    expect(m.html).toContain('href="https://tools.usps.com/');
    expect(m.text).toMatch(/In this parcel:\n+- Art print 8 × 10 in.* — Undertow × 1/);
    expect(m.text).not.toContain('follows separately');
    void id;
  });

  it('refunded after a full refund; delayed after a long hold, only once', async () => {
    h.printful.scenario({ costFactor: 10 });
    const id = await paidOrder(h);
    await settle();
    h.clock.advance(23 * 3_600_000); // the cost-guard hold refunds after 24 h; "delayed" comes after 48 h, so not yet
    await h.shop.runner.tick();
    expect(toCustomer().filter((m) => m.subject.startsWith('Delayed'))).toHaveLength(0);
    requestFullRefund({ orders: db(), clock: h.clock }, id, 'cancel', 'admin');
    await settle();
    const r = toCustomer().find((m) => m.subject.startsWith('Refunded'))!;
    expect(r.text).toContain(`We have refunded $${(order(id).paid_cents / 100).toFixed(2)}`);
    expect(r.text).toContain("We couldn't produce this order");
  });

  it('delayed: a hold older than DELAY_NOTICE_HOURS before any shipment', async () => {
    const id = await paidOrder(h);
    db().prepare("INSERT INTO holds (order_id, kind, reasons_json, since, deadline_at, deadline_action) VALUES (?, 'provider', '[\"provider_hold\"]', ?, ?, 'alert')")
      .run(id, new Date(h.clock.now()).toISOString(), new Date(h.clock.now() + 1e10).toISOString());
    h.clock.advance(49 * 3_600_000);
    await settle();
    await h.shop.runner.tick();
    await settle();
    expect(toCustomer().filter((m) => m.subject.startsWith('Delayed'))).toHaveLength(1);
    h.clock.advance(3_600_000);
    await settle();
    expect(toCustomer().filter((m) => m.subject.startsWith('Delayed'))).toHaveLength(1);
  });

  it('find my order sends the link; addresses not on the allow-list get nothing in mock mode', async () => {
    const id = await paidOrder(h);
    await settle();
    const v = visitor(h.shopUrl);
    const p = await v.go('GET', '/order/find');
    await v.go('POST', '/order/find', { _csrf: v.token(p.text), number: order(id).number, email: 'jane@example.com' });
    await settle();
    expect(toCustomer().filter((m) => m.subject.endsWith('the link'))).toHaveLength(1);
    db().prepare("UPDATE orders SET email = 'other@example.com' WHERE id = ?").run(id);
    h.clock.advance(1_000); // a new request, a new key
    await v.go('POST', '/order/find', { _csrf: v.token(p.text), number: order(id).number, email: 'other@example.com' });
    await settle();
    expect(h.ses.sent.filter((m) => m.to.includes('other@example.com'))).toEqual([]);
    expect((db().prepare("SELECT last_error FROM emails WHERE order_id = ? AND kind = 'link' ORDER BY rowid DESC LIMIT 1").get(id) as { last_error: string }).last_error).toMatch(/EMAIL_ALLOWLIST/);
  });

  it('a refused address fails the e-mail at once and alerts Klaus', async () => {
    h.ses.control.rejectNext = true;
    const id = await paidOrder(h);
    await settle();
    expect(db().prepare("SELECT state FROM jobs WHERE kind = 'email.send' AND key = ?").get(`${id}/confirmation`)).toEqual({ state: 'failed' });
    expect(alerts().some((m) => m.subject.includes('customer e-mail not sent'))).toBe(true);
  });
});

describe('alerts (09 §2)', () => {
  it('a hold alerts Klaus with the order number and an admin link, never the customer data; once a day', async () => {
    h.printful.scenario({ refuseNextOrder: true });
    const id = await paidOrder(h);
    await settle();
    const a = alerts().find((m) => m.subject.includes('Printful refused the order'))!;
    expect(a.subject).toBe(`[MOCK] Printful refused the order; it will be refunded: order ${order(id).number}`);
    expect(a.text).toContain(`/admin/orders/${id}`);
    for (const m of alerts()) {
      for (const secret of ['jane@example.com', 'Jane Doe', '1 Main St', '78701', 'Recipient']) expect(m.text + m.html).not.toContain(secret);
    }
    // New paid orders are announced too (ALERT_NEW_ORDERS defaults on).
    expect(alerts().some((m) => m.subject.startsWith('[MOCK] new paid order'))).toBe(true);
    const n = alerts().length;
    await settle();
    expect(alerts()).toHaveLength(n);
    expect(db().prepare("SELECT value_json FROM settings WHERE key = 'alert_accepted_at'").get()).toBeTruthy();
  });

  it('the reminder before a refunding deadline goes out once per hold, not once per sweep', async () => {
    const id = await paidOrder(h);
    await settle();
    openHold(db(), h.clock, id, ['amount'], 'job');
    h.clock.advance(71 * 60 * 60_000); // an hour before the 72 h deadline
    for (let minute = 0; minute < 10; minute++) {
      h.clock.advance(60_000);
      for (let i = 0; i < 5; i++) await h.shop.runner.tick();
    }
    expect(alerts().filter((m) => m.subject.includes('refunds automatically within 24 h'))).toHaveLength(1);
  });

  it('the same alert once a day, but an alert with different details the same day still goes out', async () => {
    const log = alertingLog(() => undefined, db(), h.clock, { alertNewOrders: false });
    const queued = () => (db().prepare("SELECT COUNT(*) n FROM jobs WHERE kind = 'alert.send'").get() as { n: number }).n;
    const before = queued();
    log({ level: 'alert', msg: 'reconciliation alarms', alarms: ['Printful order 1 is not the shop\'s'] });
    await settle();
    log({ level: 'alert', msg: 'reconciliation alarms', alarms: ['Printful order 1 is not the shop\'s'] });
    expect(queued()).toBe(before + 1);
    log({ level: 'alert', msg: 'reconciliation alarms', alarms: ['Printful order 1 is not the shop\'s', 'Stripe session cs_1 is paid but the shop has no order for it'] });
    expect(queued()).toBe(before + 2);
  });
});
