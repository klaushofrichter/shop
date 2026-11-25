/**
 * Jobs for the catalog (docs/design/07 §4): `sources.refresh` every 10 minutes
 * per source, and `work.original` for an enabled work whose original may have
 * changed.
 */
import type { SourceConfig } from '../catalog-config';
import { iso, type Clock } from '../clock';
import { setSetting, type Db } from '../db';
import type { ImageLimits } from '../images/display';
import type { FileStore } from '../images/store';
import { enqueue, PermanentJobError, type JobRunner } from '../jobs';
import type { ContentSource } from '../sources/types';
import type { SkuCatalog } from '../catalog-config';
import { offerEverySku } from './offers';
import { checkOriginal, refreshSource } from './works';

export const SOURCES_REFRESH_EVERY_MS = 10 * 60_000;

export interface CatalogJobDeps {
  catalog: Db;
  orders: Db;
  clock: Clock;
  sources: Map<string, ContentSource>;
  sourceConfigs: SourceConfig[];
  store: FileStore;
  limits: ImageLimits;
  /** Offer every SKU once a work's original is checked (ADR-0040). */
  skus?: SkuCatalog;
  log: (line: Record<string, unknown>) => void;
}

export function registerCatalogJobs(runner: JobRunner, d: CatalogJobDeps): void {
  runner.register('sources.refresh', {
    repeatEveryMs: SOURCES_REFRESH_EVERY_MS,
    maxAttempts: 3,
    async run(ctx) {
      const id = ctx.key;
      const config = d.sourceConfigs.find((s) => s.id === id);
      const source = d.sources.get(id);
      if (!config || !source) throw new PermanentJobError(`unknown source ${id}`);
      const result = await refreshSource(d.catalog, d.clock, config, source);
      // Schema drift is recorded where the admin and alerts (step 8) can see it.
      setSetting(d.orders, `source_problems:${id}`, result.problems, iso(d.clock));
      if (result.problems.length) d.log({ level: 'warn', msg: 'source problems', source: id, problems: result.problems.length });
      for (const w of result.toCheck) enqueue(d.orders, d.clock, 'work.original', `${w.sourceId}/${w.workId}`, w);
      d.log({ level: 'info', msg: 'source refreshed', source: id, listed: result.listed, hidden: result.hidden, toCheck: result.toCheck.length });
    },
  });

  runner.register('work.original', {
    maxAttempts: 5,
    async run(ctx) {
      const { sourceId, workId } = ctx.payload as { sourceId: string; workId: string };
      const source = d.sources.get(sourceId);
      if (!source) throw new PermanentJobError(`unknown source ${sourceId}`);
      const r = await checkOriginal(d.catalog, source, d.store, d.limits, sourceId, workId);
      const offered = d.skus ? offerEverySku(d.catalog, d.orders, d.clock, d.skus, sourceId, workId) : [];
      d.log({ level: 'info', msg: 'original checked', source: sourceId, work: workId, changed: r.changed, offered: offered.length });
    },
  });
}

/** Start the periodic refresh of every source (a no-op if one is already queued). */
export function scheduleSourceRefresh(orders: Db, clock: Clock, sourceIds: string[]): void {
  for (const id of sourceIds) enqueue(orders, clock, 'sources.refresh', id);
}
