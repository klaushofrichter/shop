/**
 * Everything the process needs, in order: configuration, the SKU and source
 * files, both databases, the job runner, the app. Any configuration error
 * stops the start with the list of problems (variable names, never values).
 *
 * Checks against Printful and Stripe (store, scopes, catalog) arrive with the
 * adapters in step 3; they refuse to start only on a wrong answer, never on no
 * answer (docs/design/06 §3).
 */
import type { Express } from 'express';
import { createApp } from './app';
import { loadSkus, loadSources, type SkuCatalog, type SourceConfig } from './catalog-config';
import { systemClock, type Clock } from './clock';
import { describeConfig, loadConfig, type Config } from './config';
import { openDatabases, type Databases } from './db';
import { registerCatalogJobs, scheduleSourceRefresh } from './catalog/jobs';
import { FileStore } from './images/store';
import { JobRunner } from './jobs';
import { createSources } from './sources';
import { workerHealth } from './worker-health';

export interface Shop {
  config: Config;
  skus: SkuCatalog;
  sources: SourceConfig[];
  dbs: Databases;
  runner: JobRunner;
  app: Express;
  stop(): void;
}

const log = (line: Record<string, unknown>) => console.log(JSON.stringify(line));

export function startShop(env: NodeJS.ProcessEnv = process.env, clock: Clock = systemClock): Shop {
  const config = loadConfig(env);
  const skus = loadSkus(config.skusConfig, config.mode);
  const sources = loadSources(config.sourcesConfig);
  const dbs = openDatabases(config.dataDir, config.mode);
  const runner = new JobRunner(dbs.orders, clock, log);
  const store = new FileStore(config.dataDir);
  const contentSources = createSources(sources, config.mode);
  registerCatalogJobs(runner, {
    catalog: dbs.catalog,
    orders: dbs.orders,
    clock,
    sources: contentSources,
    sourceConfigs: sources,
    store,
    limits: { maxInputPixels: config.maxInputPixels },
    log,
  });
  if (config.sourcesRefresh) scheduleSourceRefresh(dbs.orders, clock, sources.map((s) => s.id));
  const startedAtMs = clock.now();
  const app = createApp({
    workerHealth: () => workerHealth(dbs.orders, clock, { checkReconciliation: false, checkAlerts: false, startedAtMs }),
    dataDir: config.dataDir,
  });
  console.log(JSON.stringify({ level: 'info', msg: 'configuration', detail: describeConfig(config), skus: skus.skus.length, sources: sources.map((s) => s.id) }));
  return {
    config,
    skus,
    sources,
    dbs,
    runner,
    app,
    stop() {
      runner.stop();
      dbs.close();
    },
  };
}
