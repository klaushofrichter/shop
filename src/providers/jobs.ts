/**
 * Jobs that talk to the provider (docs/design/06 §3, 04 §2, 04 §5.3).
 *
 * While the provider is unverified (the shop started without an answer from
 * Printful), these jobs wait instead of calling it; `printful.verify` retries
 * every minute and logs an alert-level line after 30 minutes.
 */
import type { SkuCatalog } from '../catalog-config';
import { iso, type Clock } from '../clock';
import { getSetting, setSetting, transaction, type Db } from '../db';
import { enqueue, PermanentJobError, RetryLater, type JobRunner } from '../jobs';
import sharp from 'sharp';
import { compareSku, placementFor, StartupRefused, variantFor, verifyIdentity, type SkuCheck, type Verification } from './checks';
import type { FileStore } from '../images/store';
import { ProviderError, type FulfilmentProvider } from './types';

export const CATALOG_CHECK_EVERY_MS = 24 * 60 * 60_000;
const VERIFY_RETRY_MS = 60_000;
const UNVERIFIED_ALERT_MS = 30 * 60_000;
const FILE_POLL_MS = 5_000;
const FILE_GIVE_UP_MS = 10 * 60_000;
/** One mockup task per 30 s (Printful allows 2–10 a minute; 04 §7). */
const MOCKUP_SPACING_MS = 30_000;
const MOCKUP_POLL_MS = 5_000;
const MOCKUP_MAX_BYTES = 20 * 1024 * 1024;

/** Whether the provider's identity has been confirmed since the start. */
export class ProviderStatus {
  verified = false;
  since: number;
  alerted = false;
  /** The store the token sees, once verified: webhook bodies must carry it (06 §3). */
  storeId?: string;
  constructor(clock: Clock, initial: Verification) {
    this.since = clock.now();
    this.verified = initial.state === 'verified';
    if (initial.state === 'verified') this.storeId = initial.storeId;
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
  /** Where mockups are stored; absent → no mockups. */
  store?: FileStore;
  log: (line: Record<string, unknown>) => void;
}

/** Jobs that call Printful wait until its identity is verified. */
function needVerified(d: Pick<ProviderJobDeps, 'status'>): void {
  if (!d.status.verified) throw new RetryLater(VERIFY_RETRY_MS, 'provider unverified');
}

/** A provider error as the runner understands it: later, never, or as it is. */
function retryable(e: unknown): never {
  if (e instanceof ProviderError && e.kind === 'rate_limited') throw new RetryLater(e.retryAfterMs ?? 60_000, 'rate limited');
  if (e instanceof ProviderError && (e.kind === 'permanent' || e.kind === 'auth')) throw new PermanentJobError(e.message);
  throw e;
}

export function registerProviderJobs(runner: JobRunner, d: ProviderJobDeps): void {

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
        d.status.storeId = v.storeId;
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
      needVerified(d);
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
      needVerified(d);
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

/**
 * A mockup per offer and print file (04 §7): one task at Printful, polled
 * until completed, the image re-encoded without metadata and stored under
 * /mockups/<sha>.jpg. A failure leaves the display image as the fallback.
 */
export function registerMockupJob(runner: JobRunner, d: ProviderJobDeps): void {
  runner.register('mockup.create', {
    maxAttempts: 10,
    async run(ctx) {
      needVerified(d);
      if (!d.store) return;
      const { sourceId, workId, skuId } = ctx.payload as { sourceId: string; workId: string; skuId: string };
      const sku = d.skus.byId.get(skuId);
      if (!sku) throw new PermanentJobError(`unknown SKU ${skuId}`);
      const o = d.catalog
        .prepare('SELECT enabled, print_file_sha, orientation, mockup_task_id, mockup_for, mockup_sha FROM offers WHERE source_id = ? AND work_id = ? AND sku_id = ?')
        .get(sourceId, workId, skuId) as
        | { enabled: number; print_file_sha: string | null; orientation: string | null; mockup_task_id: string | null; mockup_for: string | null; mockup_sha: string | null }
        | undefined;
      if (!o?.enabled || !o.print_file_sha) return;
      if (o.mockup_sha && o.mockup_for === o.print_file_sha) return; // already current
      const taskIsCurrent = !!o.mockup_task_id && o.mockup_for === o.print_file_sha;
      const pf = d.catalog.prepare('SELECT path FROM print_files WHERE sha256 = ?').get(o.print_file_sha) as { path: string } | undefined;
      if (!pf) return;
      // mockup_for: the print file the task (and then the stored mockup) shows.
      const setTask = (taskId: string) =>
        d.catalog
          .prepare('UPDATE offers SET mockup_task_id = ?, mockup_for = ? WHERE source_id = ? AND work_id = ? AND sku_id = ?')
          .run(taskId, o.print_file_sha, sourceId, workId, skuId);
      const dropTask = () =>
        d.catalog.prepare('UPDATE offers SET mockup_task_id = NULL WHERE source_id = ? AND work_id = ? AND sku_id = ?').run(sourceId, workId, skuId);

      try {
        // A task for an older print file is abandoned.
        if (!taskIsCurrent) {
          const last = getSetting<number>(d.orders, 'mockup_last_task_at') ?? 0;
          const wait = last + MOCKUP_SPACING_MS - d.clock.now();
          if (wait > 0) throw new RetryLater(wait, 'pacing mockup tasks');
          const orientation = sku.kind === 'paper' ? (o.orientation === 'landscape' ? 'horizontal' : 'vertical') : undefined;
          const task = await d.provider.createMockup({
            productId: sku.productId,
            variantId: variantFor(sku, o.orientation === 'landscape' ? 'landscape' : 'portrait'),
            ...placementFor(sku),
            orientation,
            fileUrl: `${d.publicUrl}${pf.path}`,
          });
          setSetting(d.orders, 'mockup_last_task_at', d.clock.now(), iso(d.clock));
          setTask(task.id);
          throw new RetryLater(MOCKUP_POLL_MS, 'mockup pending');
        }
        const task = await d.provider.getMockup(o.mockup_task_id!);
        if (task.status === 'pending') throw new RetryLater(MOCKUP_POLL_MS, 'mockup pending');
        if (task.status === 'failed' || !task.urls[0]) {
          dropTask();
          d.log({ level: 'warn', msg: 'mockup failed; the display image stands in', sku: skuId, reasons: task.failures.slice(0, 3) });
          throw new PermanentJobError('mockup failed');
        }
        const raw = await d.provider.downloadMockup(task.urls[0], MOCKUP_MAX_BYTES);
        const clean = await sharp(raw, { limitInputPixels: 25_000_000 })
          .rotate()
          .resize({ width: 1000, withoutEnlargement: true })
          .toColourspace('srgb')
          .withIccProfile('srgb')
          .jpeg({ quality: 85, mozjpeg: true })
          .toBuffer();
        const sha = d.store.put('mockups', 'jpg', clean);
        d.catalog
          .prepare('UPDATE offers SET mockup_sha = ?, mockup_task_id = NULL WHERE source_id = ? AND work_id = ? AND sku_id = ? AND print_file_sha = ?')
          .run(sha, sourceId, workId, skuId, o.print_file_sha);
        d.log({ level: 'info', msg: 'mockup stored', sku: skuId });
      } catch (e) {
        if (e instanceof ProviderError && (e.kind === 'permanent' || e.kind === 'auth')) dropTask();
        retryable(e);
      }
    },
  });
}

export function scheduleProviderJobs(orders: Db, clock: Clock, status: ProviderStatus): void {
  if (status.verified) enqueue(orders, clock, 'catalog.check', 'all');
  else enqueue(orders, clock, 'printful.verify', 'startup');
}
