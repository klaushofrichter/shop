import path from 'node:path';
import compression from 'compression';
import express, { type Express } from 'express';
import { homePage, notFoundPage } from './pages';
import { appVersion } from './version';
import type { WorkerHealth } from './worker-health';

export interface AppDeps {
  /** `/health/worker`; absent → 503 (no runner in this process). */
  workerHealth?: () => WorkerHealth;
}

// The stylesheet and icon. Relative to the working directory: the repo root
// locally and in tests, /app in the image.
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(process.cwd(), 'public');

/** Strict by default: no inline script or style anywhere in the pages. */
const CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "form-action 'self' https://checkout.stripe.com",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

export function createApp(deps: AppDeps = {}): Express {
  const app = express();

  // Traefik and the pod network: req.protocol and req.ip come from the
  // forwarded headers. A CIDR list, never a hop count (vault: Building a New
  // Service, `trust proxy`).
  app.set('trust proxy', ['loopback', '10.42.0.0/16', '10.43.0.0/16']);
  app.disable('x-powered-by');

  // The shop has its own Ingress, so it compresses its own text (cluster rule
  // since 2026-11-12). compression() skips images and event streams. No size
  // threshold: every HTML page arrives compressed, which the e2e suite checks.
  app.use(compression({ threshold: 0 }));

  app.use((_req, res, next) => {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    next();
  });

  // Unauthenticated, carries the version: probe, deploy smoke test and the
  // cluster's version-exporter all read it (ADR-0016).
  app.get('/health', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ status: 'ok', version: appVersion() });
  });

  // The job runner, reconciliation and alerts (docs/design/11 §4). Names of
  // the failing checks only; no provider is called.
  app.get('/health/worker', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const health = deps.workerHealth?.() ?? { ok: false, failing: ['runner'] };
    res.status(health.ok ? 200 : 503).json({ status: health.ok ? 'ok' : 'failing', failing: health.failing });
  });

  app.use('/static', express.static(PUBLIC_DIR, { maxAge: '1h', index: false }));

  app.get('/', (_req, res) => {
    res.type('html').send(homePage());
  });

  app.use((_req, res) => {
    res.status(404).type('html').send(notFoundPage());
  });

  return app;
}
