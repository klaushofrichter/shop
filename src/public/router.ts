/**
 * The public pages (docs/design/03): picture pages, the cart, `/api/offers`,
 * and the preview gate (03 §9, ADR-0039). Server-rendered, no script needed;
 * every form carries a CSRF token; every query string value is validated.
 */
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { readCookie, SESSION_COOKIE, setCookie, verifySession } from '../admin/session';
import { iso, type Clock } from '../clock';
import type { FailSafeLimits, Mode } from '../config';
import type { SkuCatalog, SourceConfig } from '../catalog-config';
import type { WorkRow } from '../catalog/works';
import { transaction, type Db } from '../db';
import { formatCents } from '../money';
import { ART_URL, esc, homePage, layout, notFoundPage } from '../pages';
import { displayImages, getWork, sellableOffers, sellableWorkIds, type PublicOffer } from './catalog';
import { CART_COOKIE, CART_TTL_MS, cartId, formToken, formTokenOk, keyMatches, newId, PREVIEW_COOKIE, previewOk, previewProof } from './session';

export interface PublicDeps {
  catalog: Db;
  orders: Db;
  clock: Clock;
  mode: Mode;
  skus: SkuCatalog;
  sources: SourceConfig[];
  limits: FailSafeLimits;
  storeLabel: string;
  /** Signs visitor cookies (COOKIE_SECRET, or a per-process random one in mock mode). */
  secret: string;
  previewGate: boolean;
  previewKey?: string;
  /** Admin sessions pass the gate. */
  adminSecret?: string;
  allowedEmails: string[];
}

/**
 * Paths Printful, Stripe, the probes, the sign-in and art's offer check reach
 * without a cookie (03 §9, review B F2). `/api/offers` answers an empty list
 * while the gate is on.
 */
const GATE_EXEMPT = /^\/(health(\/|$)|webhooks\/|auth\/|files\/|img\/|mockups\/|static\/|preview$|admin(\/|$)|api\/offers$)/;
const WORK_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function publicRouter(d: PublicDeps): Router {
  const r = express.Router();
  const testShop = d.mode !== 'live';
  const gateActive = d.previewGate && !!d.previewKey;
  r.use(express.urlencoded({ extended: false, limit: '16kb' }));

  // ---- preview gate ----
  const adminSession = (req: Request) =>
    d.adminSecret ? verifySession(d.adminSecret, readCookie(req, SESSION_COOKIE), d.clock) : undefined;
  const throughGate = (req: Request) =>
    !gateActive || previewOk(req, d.secret, d.previewKey!) || (adminSession(req) && d.allowedEmails.includes(adminSession(req)!.email));

  r.use((req: Request, res: Response, next: NextFunction) => {
    if (testShop) res.setHeader('X-Robots-Tag', 'noindex');
    if (GATE_EXEMPT.test(req.path) || throughGate(req)) return next();
    if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'preview' });
    res.setHeader('Cache-Control', 'no-store');
    res.status(401).type('html').send(gatePage(req, res));
  });

  const gateLimiter = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false });
  r.post('/preview', gateLimiter, (req, res) => {
    const body = req.body as Record<string, string | undefined>;
    if (!formTokenOk(req, d.secret, body._csrf)) return res.status(403).type('text').send('form expired; reload the page');
    // Always back to the home page: a target taken from the form would be an open redirect.
    if (!gateActive) return res.redirect(303, '/');
    if (!keyMatches(body.key, d.previewKey!)) return res.status(401).type('html').send(gatePage(req, res, true));
    setCookie(res, PREVIEW_COOKIE, previewProof(d.secret, d.previewKey!), 30 * 24 * 60 * 60_000);
    res.redirect(303, '/');
  });

  function gatePage(req: Request, res: Response, wrong = false): string {
    return layout({
      title: 'Preview · Shop',
      description: 'This shop is in preview.',
      testShop: true,
      body: `<h1>Preview</h1>
<p>This shop isn't open yet. If you have the preview key, enter it here.</p>
${wrong ? '<p class="error" role="alert">That key is not right.</p>' : ''}
<form method="post" action="/preview">
<input type="hidden" name="_csrf" value="${esc(formToken(req, res, d.secret))}">
<label>Preview key <input name="key" type="password" autocomplete="off" required></label>
<button type="submit">Continue</button>
</form>
<p>The paintings are on view at <a href="${ART_URL}">art.klaushofrichter.net</a>.</p>`,
    });
  }

  // ---- helpers ----
  const page = (req: Request, res: Response, title: string, description: string, body: string, status = 200) =>
    res.status(status).type('html').send(layout({ title, description, body, testShop, cartCount: cartCount(req) }));

  function cartCount(req: Request): number {
    const id = cartId(req);
    if (!id) return 0;
    return (d.orders.prepare('SELECT COALESCE(SUM(quantity), 0) n FROM cart_items WHERE cart_id = ?').get(id) as { n: number }).n;
  }

  const maxQuantity = (skuId: string) => d.limits.maxQuantity[skuId] ?? d.limits.maxQuantity.default;
  const defaultSource = d.sources.find((s) => s.default)!;

  const notFound = (req: Request, res: Response) =>
    res.status(404).type('html').send(notFoundPage({ testShop, cartCount: cartCount(req) }));

  // ---- home ----
  r.get('/', (req, res) => {
    res.type('html').send(homePage({ testShop, cartCount: cartCount(req) }));
  });

  // ---- /api/offers: art shows its link only for these (03 §2). Empty while the gate is on. ----
  r.get('/api/offers', (req, res) => {
    const source = typeof req.query.source === 'string' ? req.query.source : defaultSource.id;
    if (!d.sources.some((s) => s.id === source)) return res.status(404).json({ error: 'unknown source' });
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json({ source, works: d.previewGate ? [] : sellableWorkIds(d.catalog, d.skus, d.storeLabel, source) });
  });

  // ---- picture pages ----
  const picture = (req: Request, res: Response, sourceId: string, workId: string) => {
    if (!WORK_ID.test(workId) || !d.sources.some((s) => s.id === sourceId)) return notFound(req, res);
    const w = getWork(d.catalog, sourceId, workId);
    if (!w) return notFound(req, res);
    const offers = w.enabled && w.prints_allowed ? sellableOffers(d.catalog, d.skus, d.storeLabel, w) : [];
    const title = w.title_override ?? w.title;
    const noun = w.kind === 'painting' ? 'the painting' : w.kind === 'photograph' ? 'the photograph' : '';
    const intro = `${esc(title)}${w.creator ? ` — ${esc(w.creator)}` : ''}${w.year ? `, ${esc(w.year)}` : ''}`;
    const body = offers.length
      ? `<h1>Prints of ${noun ? `${noun} ` : ''}<cite>${esc(title)}</cite></h1>
${heroImage(w)}
<p>${intro}. <a href="${esc(w.canonical_url)}">See it in the gallery</a>.</p>
<ul class="offers">${offers.map((o) => offerCard(req, res, w, o)).join('\n')}</ul>`
      : `<h1>Prints of <cite>${esc(title)}</cite> aren't available</h1>
<p>${intro}. <a href="${esc(w.canonical_url)}">See it in the gallery</a>.</p>`;
    page(req, res, `${title} · Shop`, `Prints and merchandise of ${title}.`, body);
  };
  r.get('/p/:source/:work', (req, res) => picture(req, res, String(req.params.source), String(req.params.work)));
  r.get('/p/:work', (req, res) => picture(req, res, defaultSource.id, String(req.params.work)));

  function heroImage(w: WorkRow): string {
    const imgs = displayImages(d.catalog, w);
    const jpegs = imgs.filter((i) => i.format === 'jpeg');
    const webps = imgs.filter((i) => i.format === 'webp');
    if (!jpegs.length) return '';
    const largest = jpegs[jpegs.length - 1];
    const set = (list: typeof imgs) => list.map((i) => `${esc(i.path)} ${i.width_px}w`).join(', ');
    return `<picture>
<source type="image/webp" srcset="${set(webps)}" sizes="(min-width: 44rem) 42rem, 100vw">
<img class="work-hero" src="${esc(largest.path)}" srcset="${set(jpegs)}" sizes="(min-width: 44rem) 42rem, 100vw" width="${largest.width_px}" height="${largest.height_px}" alt="${esc(w.title_override ?? w.title)}">
</picture>`;
  }

  function offerCard(req: Request, res: Response, w: WorkRow, o: PublicOffer): string {
    const id = `q-${o.sku.id}`;
    const img = o.mockupPath
      ? `<img src="${esc(o.mockupPath)}" alt="" width="480" height="480" loading="lazy">`
      : '';
    return `<li class="offer-card">${img}
<h3>${esc(o.name)}</h3>
<p class="price">$${formatCents(o.priceCents)}</p>
<form method="post" action="/cart/items">
<input type="hidden" name="_csrf" value="${esc(formToken(req, res, d.secret))}">
<input type="hidden" name="source" value="${esc(w.source_id)}">
<input type="hidden" name="work" value="${esc(w.work_id)}">
<input type="hidden" name="sku" value="${esc(o.sku.id)}">
<label for="${id}">Quantity</label> <input id="${id}" name="quantity" type="number" min="1" max="${maxQuantity(o.sku.id)}" value="1" required>
<button type="submit">Add to cart</button>
</form></li>`;
  }

  // ---- cart ----
  r.post('/cart/items', (req, res) => {
    const b = req.body as Record<string, string | undefined>;
    if (!formTokenOk(req, d.secret, b._csrf)) return res.status(403).type('text').send('form expired; reload the page');
    const sourceId = String(b.source ?? '');
    const workId = String(b.work ?? '');
    const sku = d.skus.byId.get(String(b.sku ?? ''));
    const quantity = Number(b.quantity);
    const setMode = b.mode === 'set';
    if (!sku || !WORK_ID.test(workId) || !Number.isInteger(quantity) || quantity < 0) return res.status(400).type('text').send('bad request');
    const w = getWork(d.catalog, sourceId, workId);
    const sellable = w && w.enabled && w.prints_allowed && sellableOffers(d.catalog, d.skus, d.storeLabel, w).some((o) => o.sku.id === sku.id);

    let id = cartId(req);
    const now = iso(d.clock);
    if (!id) {
      id = newId();
      setCookie(res, CART_COOKIE, id, CART_TTL_MS);
    }
    const problem = transaction(d.orders, () => {
      d.orders.prepare('INSERT OR IGNORE INTO carts (id, created_at, updated_at) VALUES (?, ?, ?)').run(id, now, now);
      const current = (d.orders.prepare('SELECT quantity FROM cart_items WHERE cart_id = ? AND source_id = ? AND work_id = ? AND sku_id = ?').get(id, sourceId, workId, sku.id) as { quantity: number } | undefined)?.quantity ?? 0;
      const next = setMode ? quantity : current + quantity;
      if (next === 0) {
        d.orders.prepare('DELETE FROM cart_items WHERE cart_id = ? AND source_id = ? AND work_id = ? AND sku_id = ?').run(id, sourceId, workId, sku.id);
      } else {
        if (!sellable) return 'This product is no longer available.';
        if (next > maxQuantity(sku.id)) return `At most ${maxQuantity(sku.id)} of this product per order; for more, please contact us.`;
        const others = (d.orders.prepare('SELECT COALESCE(SUM(quantity), 0) n FROM cart_items WHERE cart_id = ? AND NOT (source_id = ? AND work_id = ? AND sku_id = ?)').get(id, sourceId, workId, sku.id) as { n: number }).n;
        if (others + next > d.limits.maxItemsPerOrder) return `At most ${d.limits.maxItemsPerOrder} items per order; for more, please contact us.`;
        d.orders
          .prepare(
            `INSERT INTO cart_items (cart_id, source_id, work_id, sku_id, quantity) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (cart_id, source_id, work_id, sku_id) DO UPDATE SET quantity = excluded.quantity`,
          )
          .run(id, sourceId, workId, sku.id, next);
      }
      // A changed cart invalidates its quote (03 §5).
      d.orders.prepare('UPDATE carts SET updated_at = ?, quote_id = NULL WHERE id = ?').run(now, id);
      return undefined;
    });
    if (problem) return renderCart(req, res, id, problem, 409);
    res.redirect(303, '/cart');
  });

  r.get('/cart', (req, res) => renderCart(req, res, cartId(req)));

  function renderCart(req: Request, res: Response, id: string | undefined, message?: string, status = 200) {
    res.setHeader('Cache-Control', 'no-store');
    const lines = id
      ? (d.orders.prepare('SELECT source_id, work_id, sku_id, quantity FROM cart_items WHERE cart_id = ? ORDER BY source_id, work_id, sku_id').all(id) as Array<{ source_id: string; work_id: string; sku_id: string; quantity: number }>)
      : [];
    let subtotal = 0;
    let unavailable = 0;
    const groups = new Map<string, { w: WorkRow; html: string[] }>();
    for (const l of lines) {
      const w = getWork(d.catalog, l.source_id, l.work_id);
      const sku = d.skus.byId.get(l.sku_id);
      const offer = w && sku ? sellableOffers(d.catalog, d.skus, d.storeLabel, w).find((o) => o.sku.id === sku.id) : undefined;
      const key = `${l.source_id}/${l.work_id}`;
      if (!w || !sku) continue;
      if (!groups.has(key)) groups.set(key, { w, html: [] });
      const fid = `c-${l.source_id}-${l.work_id}-${l.sku_id}`;
      const form = (qty: string, label: string, mode: string, extra = '') =>
        `<form method="post" action="/cart/items"><input type="hidden" name="_csrf" value="${esc(formToken(req, res, d.secret))}"><input type="hidden" name="source" value="${esc(l.source_id)}"><input type="hidden" name="work" value="${esc(l.work_id)}"><input type="hidden" name="sku" value="${esc(l.sku_id)}"><input type="hidden" name="mode" value="${mode}">${qty}${extra}<button type="submit">${label}</button></form>`;
      if (!offer) {
        unavailable++;
        groups.get(key)!.html.push(`<div class="cart-line"><span>${esc(sku.name)}: <strong>no longer available</strong></span>${form('<input type="hidden" name="quantity" value="0">', 'Remove', 'set')}</div>`);
        continue;
      }
      const lineTotal = offer.priceCents * l.quantity;
      subtotal += lineTotal;
      groups.get(key)!.html.push(
        `<div class="cart-line"><span>${esc(offer.name)} · $${formatCents(offer.priceCents)} each</span>${form(
          `<label for="${esc(fid)}">Quantity</label> <input id="${esc(fid)}" name="quantity" type="number" min="0" max="${maxQuantity(sku.id)}" value="${l.quantity}" required>`,
          'Update',
          'set',
        )}${form('<input type="hidden" name="quantity" value="0">', 'Remove', 'set')}<span>$${formatCents(lineTotal)}</span></div>`,
      );
    }
    const kinds = new Set(lines.map((l) => d.skus.byId.get(l.sku_id)?.kind));
    const mixed = kinds.has('paper') && (kinds.has('apparel') || kinds.has('mug'));
    const body = lines.length
      ? `<h1>Your cart</h1>
${message ? `<p class="error" role="alert">${esc(message)}</p>` : ''}
${[...groups.values()]
  .map((g) => `<section class="cart-group"><h2><a href="/p/${esc(g.w.source_id)}/${esc(g.w.work_id)}">${esc(g.w.title_override ?? g.w.title)}</a></h2>${g.html.join('\n')}</section>`)
  .join('\n')}
<p class="total">Subtotal: $${formatCents(subtotal)}</p>
${mixed ? '<p>Paper prints and apparel may arrive in separate parcels.</p>' : ''}
${unavailable ? '<p>Remove the products that are no longer available to continue.</p>' : '<p>Shipping and the address come next.</p>'}`
      : `<h1>Your cart</h1>
${message ? `<p class="error" role="alert">${esc(message)}</p>` : ''}
<p>Your cart is empty. Pick a picture in the <a href="${ART_URL}">gallery</a>.</p>`;
    page(req, res, 'Cart · Shop', 'Your cart.', body, status);
  }

  r.use((req, res) => notFound(req, res));
  return r;
}
