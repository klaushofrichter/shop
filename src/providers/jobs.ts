/**
 * Jobs that talk to the provider (docs/design/06 §3, 04 §2, 04 §5.3).
 *
 * While the provider is unverified (the shop started without an answer from
 * Printful), these jobs wait instead of calling it; `printful.verify` retries
 * every minute and logs an alert-level line after 30 minutes (alerts by e-mail
 * arrive with step 8).
 */
import type { SkuCatalog } from '../catalog-config';
import { iso, type Clock } from '../clock';
import { transaction, type Db } from '../db';
import { enqueue, PermanentJobError, RetryLater, type JobRunner } from '../jobs';
import { compareSku, StartupRefused, verifyIdentity, type SkuCheck, type Verification } from './checks';
import { ProviderError, type FulfilmentProvider } from './types';

export const CATALOG_CHECK_EVERY_MS = 24 * 60 * 60_000;
const VERIFY_RETRY_MS = 60_000;
const UNVERIFIED_ALERT_MS = 30 * 60_000;
const FILE_POLL_MS = 5_000;
const FILE_GIVE_UP_MS = 10 * 60_000;

/** Whether the provider's identity has been confirmed since the start. */
export class ProviderStatus {
  verified = false;
  since: number;
  alerted = false;
  constructor(clock: Clock, initial: Verification) {
    this.since = clock.now();
    this.verified = initial.state === 'verified';
  }
}

export interface ProviderJobDeps {
  provider: FulfilmentProvider;
  status: ProviderStatus;
  expectedStore: string | undefined;
  /** Which store's file registrations these are: 'mock' | 'test' | 'live'. */
  storeLabel: string;
  publicUrl: string;
  catalog: Db;
  orders: Db;
  clock: Clock;
  skus: SkuCatalog;
  log: (line: Record<string, unknown>) => void;
}

export function registerProviderJobs(runner: JobRunner, d: ProviderJobDeps): void {
  const needVerified = () => {
    if (!d.status.verified) throw new RetryLater(VERIFY_RETRY_MS, 'provider unverified');
  };
  const retryable = (e: unknown) => {
    if (e instanceof ProviderError && e.kind === 'rate_limited') throw new RetryLater(e.retryAfterMs ?? 60_000, 'rate limited');
    if (e instanceof ProviderError && (e.kind === 'permanent' || e.kind === 'auth')) throw new PermanentJobError(e.message);
    throw e;
  };

  runner.register('printful.verify', {
    maxAttempts: 1_000_000,
    async run() {
      if (d.status.verified) return;
      let v: Verification;
      try {
        v = await verifyIdentity(d.provider, d.expectedStore);
      } catch (e) {
        // A wrong answer after the start: stop using the provider, loudly.
        if (e instanceof StartupRefused) d.log({ level: 'alert', msg: 'Printful identity wrong', detail: e.message });
        throw e;
      }
      if (v.state === 'verified') {
        d.status.verified = true;
        d.log({ level: 'info', msg: 'Printful verified' });
        enqueue(d.orders, d.clock, 'catalog.check', 'all');
        return;
      }
      if (!d.status.alerted && d.clock.now() - d.status.since > UNVERIFIED_ALERT_MS) {
        d.status.alerted = true;
        d.log({ level: 'alert', msg: 'Printful unverified for 30 minutes', reason: v.reason });
      }
      throw new RetryLater(VERIFY_RETRY_MS, v.reason);
    },
  });

  runner.register('catalog.check', {
    repeatEveryMs: CATALOG_CHECK_EVERY_MS,
    maxAttempts: 5,
    async run() {
      needVerified();
      const results: SkuCheck[] = [];
      for (const sku of d.skus.skus) {
        const ids = [...new Set([sku.variants.any, sku.variants.portrait, sku.variants.landscape].filter((v): v is number => !!v))];
        try {
          for (const id of ids) {
            const r = compareSku(sku, await d.provider.describeVariant(id));
            results.push(r);
            if (!r.ok) break;
          }
        } catch (e) {
          // Unknown variant: a mismatch. No answer: keep the last good check (never disable on a timeout).
          if (e instanceof ProviderError && e.kind === 'permanent') results.push({ skuId: sku.id, ok: false, problem: e.message });
          else retryable(e);
        }
      }
      const now = iso(d.clock);
      transaction(d.catalog, () => {
        const up = d.catalog.prepare(
          `INSERT INTO sku_checks (sku_id, ok, wholesale_cents, problem, checked_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(sku_id) DO UPDATE SET ok = excluded.ok, wholesale_cents = excluded.wholesale_cents, problem = excluded.problem, checked_at = excluded.checked_at`,
        );
        // One row per SKU: a failure in any of its variants wins.
        const bySku = new Map<string, SkuCheck>();
        for (const r of results) if (!bySku.has(r.skuId) || !r.ok) bySku.set(r.skuId, r);
        for (const r of bySku.values()) up.run(r.skuId, r.ok ? 1 : 0, r.wholesaleCents ?? null, r.problem ?? null, now);
      });
      const bad = results.filter((r) => !r.ok);
      if (bad.length) d.log({ level: 'alert', msg: 'SKUs disabled by the catalog check', skus: bad.map((b) => b.skuId) });
    },
  });

  // Register a print file in the provider's library and wait for `ok` (04 §5.3).
  runner.register('printfile.register', {
    maxAttempts: 20,
    async run(ctx) {
      needVerified();
      const { sha } = ctx.payload as { sha: string };
      if (!/^[0-9a-f]{64}$/.test(sha)) throw new PermanentJobError('malformed print file hash');
      const pf = d.catalog.prepare('SELECT path FROM print_files WHERE sha256 = ? AND deleted_at IS NULL').get(sha) as { path: string } | undefined;
      if (!pf) throw new PermanentJobError(`no print file ${sha.slice(0, 12)}`);
      const row = d.catalog
        .prepare(`SELECT provider_file_id, status, checked_at FROM provider_files WHERE print_file_sha = ? AND provider = 'printful' AND store = ?`)
        .get(sha, d.storeLabel) as { provider_file_id: string | null; status: string; checked_at: string } | undefined;
      if (row?.status === 'ok' || row?.status === 'failed') return;
      let file;
      try {
        file = row?.provider_file_id ? await d.provider.getFile(row.provider_file_id) : await d.provider.registerFile(`${d.publicUrl}${pf.path}`);
      } catch (e) {
        retryable(e);
        return;
      }
      const now = iso(d.clock);
      const firstAt = row ? Date.parse(row.checked_at) : d.clock.now();
      let status: string = file.status;
      let error: string | null = null;
      if (status === 'waiting' && d.clock.now() - firstAt > FILE_GIVE_UP_MS) {
        status = 'failed';
        error = 'still waiting after 10 minutes';
      }
      d.catalog
        .prepare(
          `INSERT INTO provider_files (print_file_sha, provider, store, provider_file_id, status, last_error, checked_at)
           VALUES (?, 'printful', ?, ?, ?, ?, ?)
           ON CONFLICT (print_file_sha, provider, store) DO UPDATE SET provider_file_id = excluded.provider_file_id,
             status = excluded.status, last_error = excluded.last_error, checked_at = excluded.checked_at`,
        )
        // While waiting, checked_at keeps the first registration time (for the give-up rule).
        .run(sha, d.storeLabel, file.id, status, error, status === 'waiting' ? (row?.checked_at ?? now) : now);
      if (status === 'failed') d.log({ level: 'alert', msg: 'print file failed at Printful', file: sha.slice(0, 12), error });
      if (status === 'waiting') throw new RetryLater(FILE_POLL_MS, 'file processing');
    },
  });
}

export function scheduleProviderJobs(orders: Db, clock: Clock, status: ProviderStatus): void {
  if (status.verified) enqueue(orders, clock, 'catalog.check', 'all');
  else enqueue(orders, clock, 'printful.verify', 'startup');
}
