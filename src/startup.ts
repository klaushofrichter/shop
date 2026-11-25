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
import { ProviderStatus, registerMockupJob, registerProviderJobs, scheduleProviderJobs } from './providers/jobs';
import { PrintfulClient } from './providers/printful';
import { workerHealth } from './worker-health';
import { googleSignIn } from './admin/auth';
import { randomBytes } from 'node:crypto';
import { StripeClient } from './payments/stripe';
import { registerStripeEventJob } from './orders/webhooks';
import { registerSubmitJob } from './orders/submit';
import { onStripeEvent, registerRefundJobs, scheduleDeadlines } from './orders/refunds';
import { registerPrintfulEventJob } from './orders/fulfilment-events';
import { RetryLater } from './jobs';

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
  const contentSources = createSources(sources, config.mode, undefined, config.mockSourceUrl);
  registerCatalogJobs(runner, {
    catalog: dbs.catalog,
    orders: dbs.orders,
    clock,
    sources: contentSources,
    sourceConfigs: sources,
    store,
    limits: { maxInputPixels: config.maxInputPixels },
    skus,
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
  const provider = config.printful.token ? new PrintfulClient({ baseUrl: config.printful.baseUrl, token: config.printful.token, mayConfirm: config.mode !== 'test' }) : undefined;
  const stripe = config.stripe.secretKey ? new StripeClient({ apiBase: config.stripe.apiBase, secretKey: config.stripe.secretKey }) : undefined;
  // Status links (ADR-0037); mock mode without a secret gets a per-process one (links end with the process).
  const statusSecret = config.statusTokenSecret ?? randomBytes(32).toString('hex');
  const paymentDeps = stripe ? { orders: dbs.orders, clock, stripe, limits: config.limits, log } : undefined;
  const refundDeps = stripe ? { orders: dbs.orders, clock, stripe, provider, log } : undefined;
  if (refundDeps) {
    registerRefundJobs(runner, refundDeps);
    scheduleDeadlines(dbs.orders, clock);
  }
  if (paymentDeps) registerStripeEventJob(runner, paymentDeps, refundDeps ? (type, id) => onStripeEvent(refundDeps, type, id) : undefined);
  // Submission (06 §4) needs Printful and Stripe; without them the job waits.
  if (provider && stripe) {
    registerSubmitJob(runner, {
      orders: dbs.orders, catalog: dbs.catalog, clock, provider, stripe, mode: config.mode, publicUrl: config.publicUrl,
      skus, quote: config.quote, fulfilment: config.fulfilment, log,
    });
  }
  if (provider) registerPrintfulEventJob(runner, { orders: dbs.orders, clock, provider, log });
  // E-mails arrive with step 8: their jobs wait until then.
  for (const kind of provider && stripe ? ['email.send'] : ['order.submit', 'email.send']) {
    runner.register(kind, { maxAttempts: 1_000_000, run: async () => { throw new RetryLater(6 * 60 * 60_000, `${kind} is not built yet`); } });
  }
  // Set once ready() has checked Printful's identity.
  let providerStatus: ProviderStatus | undefined;
  const app = createApp({
    workerHealth: () => workerHealth(dbs.orders, clock, { checkReconciliation: false, checkAlerts: false, startedAtMs }),
    dataDir: config.dataDir,
    mockStripePages: config.mockStripePages,
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
    webhooks: { orders: dbs.orders, clock, stripeWebhookSecret: config.stripe.webhookSecret, log },
    printfulWebhooks: {
      orders: dbs.orders,
      clock,
      secretHex: config.printful.webhookSecret,
      publicKey: config.printful.webhookPublicKey,
      storeId: () => providerStatus?.storeId,
      log,
    },
    publicSite: {
      catalog: dbs.catalog,
      orders: dbs.orders,
      clock,
      mode: config.mode,
      skus,
      sources,
      limits: config.limits,
      storeLabel: config.mode,
      // Visitor cookies are signed with COOKIE_SECRET; mock mode without one gets a per-process secret.
      secret: config.admin.cookieSecret ?? randomBytes(32).toString('hex'),
      previewGate: config.previewGate,
      previewKey: config.previewKey,
      adminSecret: config.admin.cookieSecret,
      allowedEmails: config.admin.allowedEmails,
      statusSecret,
      checkout: paymentDeps
        ? {
            ...paymentDeps,
            catalog: dbs.catalog,
            skus,
            storeLabel: config.mode,
            publicUrl: config.publicUrl,
            statusSecret,
            // Stripe Tax (ADR-0012): it taxes where Klaus is registered; the mock has its own tax table.
            automaticTax: true,
          }
        : undefined,
      quote: {
        settings: config.quote,
        provider,
        providerReady: () => !!providerStatus?.verified,
        log,
      },
    },
  });
  console.log(JSON.stringify({ level: 'info', msg: 'configuration', detail: describeConfig(config), skus: skus.skus.length, sources: sources.map((s) => s.id) }));
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
      providerStatus = status;
      log({ level: verification.state === 'verified' ? 'info' : 'warn', msg: `Printful ${verification.state}` });
      const providerDeps = {
        provider,
        status,
        expectedStore: config.printful.expectedStore,
        storeLabel: config.mode,
        publicUrl: config.publicUrl,
        catalog: dbs.catalog,
        orders: dbs.orders,
        clock,
        skus,
        store,
        log,
      };
      registerProviderJobs(runner, providerDeps);
      registerMockupJob(runner, providerDeps);
      scheduleProviderJobs(dbs.orders, clock, status);
    },
    stop() {
      runner.stop();
      dbs.close();
    },
  };
  return shop;
}
