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
import { registerOfferJobs } from './catalog/offers';
import { FileStore } from './images/store';
import { JobRunner } from './jobs';
import { createSources } from './sources';
import { verifyIdentity } from './providers/checks';
import { ProviderStatus, registerProviderJobs, scheduleProviderJobs } from './providers/jobs';
import { PrintfulClient } from './providers/printful';
import { workerHealth } from './worker-health';
import { googleSignIn } from './admin/auth';

export interface Shop {
  config: Config;
  skus: SkuCatalog;
  sources: SourceConfig[];
  dbs: Databases;
  runner: JobRunner;
  app: Express;
  provider?: PrintfulClient;
  providerStatus?: ProviderStatus;
  /**
   * Checks that need the network, before the shop listens: Printful's store
   * and scopes. A wrong answer throws (the start is refused); no answer leaves
   * the provider unverified and the shop starts anyway (06 §3).
   */
  ready(): Promise<void>;
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
  registerOfferJobs(runner, {
    catalog: dbs.catalog,
    orders: dbs.orders,
    clock,
    sources: contentSources,
    skus,
    store,
    limits: { maxInputPixels: config.maxInputPixels },
    registerFiles: !!config.printful.token,
    log,
  });
  if (config.sourcesRefresh) scheduleSourceRefresh(dbs.orders, clock, sources.map((s) => s.id));
  const startedAtMs = clock.now();
  const app = createApp({
    workerHealth: () => workerHealth(dbs.orders, clock, { checkReconciliation: false, checkAlerts: false, startedAtMs }),
    dataDir: config.dataDir,
    auth: {
      google:
        config.admin.googleClientId && config.admin.googleClientSecret && config.admin.googleRedirectUri
          ? googleSignIn(config.admin.googleClientId, config.admin.googleClientSecret, config.admin.googleRedirectUri)
          : undefined,
      cookieSecret: config.admin.cookieSecret,
      allowedEmails: config.admin.allowedEmails,
      clock,
      log,
    },
    admin: {
      catalog: dbs.catalog,
      orders: dbs.orders,
      clock,
      mode: config.mode,
      cookieSecret: config.admin.cookieSecret,
      allowedEmails: config.admin.allowedEmails,
      publicUrl: config.publicUrl,
      skus,
      storeLabel: config.mode,
    },
  });
  console.log(JSON.stringify({ level: 'info', msg: 'configuration', detail: describeConfig(config), skus: skus.skus.length, sources: sources.map((s) => s.id) }));
  const provider = config.printful.token ? new PrintfulClient({ baseUrl: config.printful.baseUrl, token: config.printful.token }) : undefined;
  const shop: Shop = {
    config,
    skus,
    sources,
    dbs,
    runner,
    app,
    provider,
    async ready() {
      if (!provider) {
        log({ level: 'warn', msg: 'no Printful token: provider jobs off' });
        return;
      }
      const verification = await verifyIdentity(provider, config.printful.expectedStore);
      const status = new ProviderStatus(clock, verification);
      shop.providerStatus = status;
      log({ level: verification.state === 'verified' ? 'info' : 'warn', msg: `Printful ${verification.state}` });
      registerProviderJobs(runner, {
        provider,
        status,
        expectedStore: config.printful.expectedStore,
        storeLabel: config.mode,
        publicUrl: config.publicUrl,
        catalog: dbs.catalog,
        orders: dbs.orders,
        clock,
        skus,
        log,
      });
      scheduleProviderJobs(dbs.orders, clock, status);
    },
    stop() {
      runner.stop();
      dbs.close();
    },
  };
  return shop;
}
