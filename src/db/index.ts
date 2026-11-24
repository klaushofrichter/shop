/**
 * The two SQLite files (docs/design/07 §3, ADR-0029): `catalog.db`, shared by
 * every mode, and `<mode>.db`. WAL, foreign keys on, numbered migrations.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Mode } from '../config';
import { CATALOG_MIGRATIONS, MODE_MIGRATIONS } from './migrations';

export type Db = DatabaseSync;

export interface Databases {
  catalog: Db;
  orders: Db;
  close(): void;
}

/** Open (or create) a database file and bring it to the latest migration. */
export function openDb(file: string, migrations: string[]): Db {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db, migrations, file);
  return db;
}

export function migrate(db: Db, migrations: string[], label = 'database'): void {
  const current = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  if (current > migrations.length) {
    // A newer image wrote this file; an older one must not touch it.
    throw new Error(`${label} is at migration ${current}, this build knows ${migrations.length}`);
  }
  for (let n = current; n < migrations.length; n++) {
    transaction(db, () => {
      db.exec(migrations[n]);
      db.exec(`PRAGMA user_version = ${n + 1}`);
    });
  }
}

export function openDatabases(dataDir: string, mode: Mode): Databases {
  const catalog = openDb(path.join(dataDir, 'catalog.db'), CATALOG_MIGRATIONS);
  const orders = openDb(path.join(dataDir, `${mode}.db`), MODE_MIGRATIONS);
  return {
    catalog,
    orders,
    close() {
      catalog.close();
      orders.close();
    },
  };
}

/** In-memory databases for tests. */
export function memoryDatabases(): Databases {
  const catalog = openDb(':memory:', CATALOG_MIGRATIONS);
  const orders = openDb(':memory:', MODE_MIGRATIONS);
  return { catalog, orders, close: () => (catalog.close(), orders.close()) };
}

/**
 * Run `fn` in one write transaction (`BEGIN IMMEDIATE`, so concurrent writers
 * queue instead of failing on upgrade). Nested calls join the outer one.
 */
export function transaction<T>(db: Db, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw e;
  }
}

/** Settings rows (`settings`, mode file): small JSON values such as the runner's heartbeat. */
export function getSetting<T>(db: Db, key: string): T | undefined {
  const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as { value_json: string } | undefined;
  return row ? (JSON.parse(row.value_json) as T) : undefined;
}

export function setSetting(db: Db, key: string, value: unknown, at: string, by: string | null = null): void {
  db.prepare(
    `INSERT INTO settings (key, value_json, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  ).run(key, JSON.stringify(value), at, by);
}
