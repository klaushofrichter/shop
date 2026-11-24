import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getSetting, memoryDatabases, migrate, openDatabases, setSetting, transaction } from '../src/db';
import { CATALOG_MIGRATIONS, MODE_MIGRATIONS } from '../src/db/migrations';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tables = (db: { prepare(s: string): { all(): unknown[] } }) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);

describe('database files (ADR-0029)', () => {
  it('creates catalog.db and the mode file, migrated, in WAL mode', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'shop-db-'));
    dirs.push(dir);
    const dbs = openDatabases(dir, 'test');
    expect(tables(dbs.catalog)).toEqual(['display_images', 'offers', 'print_files', 'provider_files', 'sku_checks', 'works']);
    expect(tables(dbs.orders)).toContain('orders');
    expect(tables(dbs.orders)).not.toContain('works');
    expect(dbs.orders.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    expect(dbs.orders.prepare('PRAGMA user_version').get()).toEqual({ user_version: MODE_MIGRATIONS.length });
    dbs.close();
    // Reopening is a no-op migration.
    openDatabases(dir, 'test').close();
  });

  it('refuses a file written by a newer build', () => {
    const { orders } = memoryDatabases();
    orders.exec(`PRAGMA user_version = ${MODE_MIGRATIONS.length + 1}`);
    expect(() => migrate(orders, MODE_MIGRATIONS)).toThrow(/this build knows/);
  });

  it('enforces the schema: one open checkout per cart (I9), positive quantities', () => {
    const { orders } = memoryDatabases();
    const insert = orders.prepare(
      `INSERT INTO orders (id, number, payment_state, cart_id, ship_country, shipping_method, shipping_cents, items_cents,
         checkout_idempotency_key, created_at, updated_at)
       VALUES (?, ?, ?, 'cart-1', 'US', 'STANDARD', 0, 0, ?, 'now', 'now')`,
    );
    insert.run('o1', '11111', 'checkout_open', 'k1');
    expect(() => insert.run('o2', '22222', 'checkout_open', 'k2')).toThrow(/UNIQUE/);
    insert.run('o3', '33333', 'closed_unpaid', 'k3');
    orders.exec(`INSERT INTO carts (id, created_at, updated_at) VALUES ('cart-1', 'now', 'now')`);
    expect(() =>
      orders.exec(`INSERT INTO cart_items (cart_id, source_id, work_id, sku_id, quantity) VALUES ('cart-1', 'art', 'w', 's', 0)`),
    ).toThrow(/CHECK/);
  });

  it('keeps catalog references inside catalog.db', () => {
    const { catalog } = memoryDatabases();
    expect(() =>
      catalog.exec(`INSERT INTO offers (source_id, work_id, sku_id) VALUES ('art', 'missing', 'print-8x10')`),
    ).toThrow(/FOREIGN KEY/);
    expect(CATALOG_MIGRATIONS.join()).not.toMatch(/REFERENCES orders/);
  });
});

describe('transaction', () => {
  it('rolls back on error and joins nested calls', () => {
    const { orders } = memoryDatabases();
    expect(() =>
      transaction(orders, () => {
        setSetting(orders, 'a', 1, 'now');
        transaction(orders, () => setSetting(orders, 'b', 2, 'now'));
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(getSetting(orders, 'a')).toBeUndefined();
    expect(getSetting(orders, 'b')).toBeUndefined();
    transaction(orders, () => setSetting(orders, 'a', { x: 1 }, 'now'));
    expect(getSetting(orders, 'a')).toEqual({ x: 1 });
  });
});
