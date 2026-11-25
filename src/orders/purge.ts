/**
 * Retention (docs/design/07 §6), nightly:
 * - personal data on orders 180 days after completion (country and state
 *   kept), and the Stripe Customer with it;
 * - orders never paid after 7 days, with their Customer;
 * - Printful webhook bodies after 30 days; carts after 30 days, quotes after 7;
 * - finished jobs after 30 days;
 * - test mode: test-store drafts after 7 days;
 * - live mode only: print files no offer and no order item of the last 12
 *   months uses (the row stays, `deleted_at` set).
 */
import { rmSync } from 'node:fs';
import path from 'node:path';
import { iso, type Clock } from '../clock';
import type { Mode } from '../config';
import { transaction, type Db } from '../db';
import type { FileStore } from '../images/store';
import { enqueue, type JobRunner } from '../jobs';
import type { StripeClient } from '../payments/stripe';
import type { FulfilmentProvider } from '../providers/types';

export interface PurgeDeps {
  orders: Db;
  catalog: Db;
  clock: Clock;
  mode: Mode;
  stripe?: StripeClient;
  provider?: FulfilmentProvider;
  store?: FileStore;
  log: (line: Record<string, unknown>) => void;
}

const DAY = 24 * 60 * 60_000;

export interface PurgeReport {
  personalData: number;
  unpaid: number;
  payloads: number;
  carts: number;
  quotes: number;
  jobs: number;
  testDrafts: number;
  printFiles: number;
  errors: string[];
}

async function deleteCustomer(d: PurgeDeps, customerId: string | null, errors: string[]) {
  if (!customerId || !d.stripe) return;
  try {
    await d.stripe.deleteCustomer(customerId);
  } catch (e) {
    // Already gone counts; anything else is retried tomorrow by the caller's bookkeeping.
    if (!/No such customer/i.test((e as Error).message)) {
      errors.push(`customer: ${(e as Error).message.slice(0, 120)}`);
      throw e;
    }
  }
}

export async function purge(d: PurgeDeps): Promise<PurgeReport> {
  const now = d.clock.now();
  const ago = (days: number) => new Date(now - days * DAY).toISOString();
  const rep: PurgeReport = { personalData: 0, unpaid: 0, payloads: 0, carts: 0, quotes: 0, jobs: 0, testDrafts: 0, printFiles: 0, errors: [] };

  // Personal data, 180 days after completion.
  const old = d.orders
    .prepare('SELECT id, stripe_customer_id FROM orders WHERE completed_at IS NOT NULL AND completed_at < ? AND purged_at IS NULL')
    .all(ago(180)) as Array<{ id: string; stripe_customer_id: string | null }>;
  for (const o of old) {
    try {
      await deleteCustomer(d, o.stripe_customer_id, rep.errors);
    } catch {
      continue;
    }
    transaction(d.orders, () => {
      d.orders
        .prepare(
          `UPDATE orders SET email = NULL, ship_name = NULL, ship_line1 = NULL, ship_line2 = NULL, ship_city = NULL, ship_zip = NULL,
             card_fingerprint = NULL, stripe_customer_id = NULL, purged_at = ?, updated_at = ? WHERE id = ? AND purged_at IS NULL`,
        )
        .run(iso(d.clock), iso(d.clock), o.id);
      d.orders.prepare("INSERT INTO order_events (order_id, part, to_value, cause, at) VALUES (?, 'note', 'purged', 'job', ?)").run(o.id, iso(d.clock));
    });
    rep.personalData++;
  }

  // Orders never paid, after 7 days: deleted, the number freed.
  const unpaid = d.orders
    .prepare("SELECT id, stripe_customer_id FROM orders WHERE payment_state = 'closed_unpaid' AND created_at < ?")
    .all(ago(7)) as Array<{ id: string; stripe_customer_id: string | null }>;
  for (const o of unpaid) {
    try {
      await deleteCustomer(d, o.stripe_customer_id, rep.errors);
    } catch {
      continue;
    }
    transaction(d.orders, () => {
      for (const t of ['order_events', 'order_items', 'holds', 'refunds', 'shipments', 'provider_orders']) d.orders.prepare(`DELETE FROM ${t} WHERE order_id = ?`).run(o.id);
      d.orders.prepare("DELETE FROM orders WHERE id = ? AND payment_state = 'closed_unpaid'").run(o.id);
      d.orders.prepare('UPDATE carts SET open_order_id = NULL WHERE open_order_id = ?').run(o.id);
    });
    rep.unpaid++;
  }

  transaction(d.orders, () => {
    rep.payloads = Number(d.orders.prepare("UPDATE inbound_events SET payload_json = NULL WHERE provider = 'printful' AND payload_json IS NOT NULL AND received_at < ?").run(ago(30)).changes);
    rep.quotes = Number(d.orders.prepare('DELETE FROM quotes WHERE created_at < ?').run(ago(7)).changes);
    const carts = d.orders.prepare('SELECT id FROM carts WHERE updated_at < ? AND open_order_id IS NULL').all(ago(30)) as Array<{ id: string }>;
    for (const c of carts) {
      d.orders.prepare('DELETE FROM cart_items WHERE cart_id = ?').run(c.id);
      d.orders.prepare('DELETE FROM carts WHERE id = ?').run(c.id);
    }
    rep.carts = carts.length;
    rep.jobs = Number(d.orders.prepare("DELETE FROM jobs WHERE state IN ('done', 'failed') AND updated_at < ?").run(ago(30)).changes);
  });

  // Test mode: the test store's drafts, after 7 days.
  if (d.mode === 'test' && d.provider) {
    const drafts = d.orders
      .prepare("SELECT p.order_id, p.attempt, p.provider_order_id FROM provider_orders p WHERE p.state = 'draft' AND p.provider_order_id IS NOT NULL AND p.updated_at < ?")
      .all(ago(7)) as Array<{ order_id: string; attempt: number; provider_order_id: string }>;
    for (const p of drafts) {
      try {
        if ((await d.provider.deleteOrder(p.provider_order_id)) === 'deleted') {
          d.orders.prepare("UPDATE provider_orders SET state = 'deleted', updated_at = ? WHERE order_id = ? AND attempt = ?").run(iso(d.clock), p.order_id, p.attempt);
          rep.testDrafts++;
        }
      } catch (e) {
        rep.errors.push(`test draft: ${(e as Error).message.slice(0, 120)}`);
      }
    }
  }

  // Live mode only, checking live.db: print files nothing uses any more.
  if (d.mode === 'live' && d.store) {
    const recent = new Set(
      (d.orders.prepare('SELECT DISTINCT i.print_file_sha s FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.created_at >= ?').all(ago(365)) as Array<{ s: string }>).map((r) => r.s),
    );
    const files = d.catalog
      .prepare('SELECT sha256, path FROM print_files p WHERE deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM offers o WHERE o.print_file_sha = p.sha256)')
      .all() as Array<{ sha256: string; path: string }>;
    for (const f of files) {
      if (recent.has(f.sha256)) continue;
      const name = path.basename(f.path);
      if (!/^[0-9a-f]{64}\.(jpg|png)$/.test(name)) continue;
      rmSync(d.store.pathOf('files', name), { force: true });
      d.catalog.prepare('UPDATE print_files SET deleted_at = ? WHERE sha256 = ?').run(iso(d.clock), f.sha256);
      rep.printFiles++;
    }
  }

  d.log({ level: rep.errors.length ? 'warn' : 'info', msg: 'purge', ...rep });
  return rep;
}

export function registerPurgeJob(runner: JobRunner, d: PurgeDeps): void {
  runner.register('purge', {
    repeatEveryMs: DAY,
    maxAttempts: 2,
    async run() {
      await purge(d);
    },
  });
}

export function schedulePurge(orders: Db, clock: Clock): void {
  enqueue(orders, clock, 'purge', 'nightly', undefined, 60 * 60_000);
}
