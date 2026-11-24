/**
 * Mock mode only (docs/design/14 §9): the shop passes the mock Stripe checkout
 * page through under /__mock-pages/stripe/, so the browser e2e sees one origin
 * and the shop's CSP. Fixed paths only: the checkout page and its three
 * buttons, with the session id checked. Never mounted in test or live mode.
 */
import express, { type Router } from 'express';
import rateLimit from 'express-rate-limit';

const SESSION = /^cs_mock_[A-Za-z0-9_]{1,64}$/;
const ACTIONS = ['pay', 'decline', 'cancel'] as const;

export function mockPagesRouter(stripeBase: string): Router {
  const r = express.Router();
  r.use('/__mock-pages', rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: 'draft-8', legacyHeaders: false }));

  async function pass(res: express.Response, url: URL, method: 'GET' | 'POST') {
    const upstream = await fetch(url, { method, redirect: 'manual', ...(method === 'POST' ? { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '' } : {}) });
    res.status(upstream.status);
    const location = upstream.headers.get('location');
    if (location) res.setHeader('Location', location);
    res.setHeader('Cache-Control', 'no-store');
    res.type(upstream.headers.get('content-type') ?? 'text/plain').send(Buffer.from(await upstream.arrayBuffer()));
  }

  r.get('/__mock-pages/stripe/checkout/:id', async (req, res, next) => {
    const id = String(req.params.id);
    if (!SESSION.test(id)) return next();
    await pass(res, new URL(`/checkout/${id}`, stripeBase), 'GET');
  });
  r.post('/__mock-pages/stripe/checkout/:id/:action', async (req, res, next) => {
    const id = String(req.params.id);
    const action = ACTIONS.find((a) => a === req.params.action);
    if (!SESSION.test(id) || !action) return next();
    await pass(res, new URL(`/checkout/${id}/${action}`, stripeBase), 'POST');
  });
  return r;
}
