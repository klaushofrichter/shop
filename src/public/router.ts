/**
 * The public pages (docs/design/03): picture pages, the cart, `/api/offers`,
 * and the preview gate (03 §9, ADR-0039). Server-rendered, no script needed;
 * every form carries a CSRF token; every query string value is validated.
 */
import express, { type NextFunction, type Request, type RequestHandler, type Response, type Router } from 'express';
import { perClient } from '../limiter';
import { readCookie, SESSION_COOKIE, setCookie, verifySession } from '../admin/session';
import { iso, type Clock } from '../clock';
import type { FailSafeLimits, Mode } from '../config';
import type { SkuCatalog, SourceConfig } from '../catalog-config';
import type { WorkRow } from '../catalog/works';
import { transaction, type Db } from '../db';
import { usd } from '../money';
import { ART_URL, esc, homePage, layout, notFoundPage } from '../pages';
import { displayImages, getWork, sellableOffers, sellableWorkIds, type PublicOffer } from './catalog';
import { countZipRejection, createQuote, normaliseAddress, shippingLabel, type AddressErrors, type AddressInput, type QuoteDeps, type QuoteItem, type QuoteOption } from './quote';
import { US_STATES } from './zip';
import { startCheckout, type CheckoutDeps } from '../orders/checkout';
import { ORDER_ID, statusTokenOk } from '../orders/ids';
import { applyPayment } from '../orders/payment';
import { customerStatus } from '../orders/status';
import { queueEmail } from '../email/jobs';
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
  /** Checkout and payment (05 §3); absent → "payment isn't open yet". */
  checkout?: CheckoutDeps;
  /** Signs the status links (ADR-0037). */
  statusSecret: string;
  /** The quote (05 §2); without a provider the quote says shipping can't be calculated. */
  quote: Omit<QuoteDeps, 'catalog' | 'orders' | 'clock' | 'skus' | 'storeLabel'>;
}

const FIELDS: Array<[keyof AddressInput, string, string]> = [
  ['name', 'Full name', 'name'],
  ['email', 'E-mail', 'email'],
  ['line1', 'Address line 1', 'address-line1'],
  ['line2', 'Address line 2 (optional)', 'address-line2'],
  ['city', 'City', 'address-level2'],
  ['state', 'State', 'address-level1'],
  ['zip', 'ZIP code', 'postal-code'],
];

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

  /** Every public form carries a token (03); placed after a route's limiter. */
  const csrf: RequestHandler = (req, res, next) => {
    if (formTokenOk(req, d.secret, (req.body as Record<string, string | undefined> | undefined)?._csrf)) return next();
    res.status(403).type('text').send('form expired; reload the page');
  };

  r.post('/preview', perClient(60_000, 10), csrf, (req, res) => {
    const body = req.body as Record<string, string | undefined>;
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
<p class="price">${usd(o.priceCents)}</p>
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
  r.post('/cart/items', csrf, (req, res) => {
    const b = req.body as Record<string, string | undefined>;
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

  function renderCart(
    req: Request,
    res: Response,
    id: string | undefined,
    message?: string,
    status = 200,
    addressDraft?: Partial<AddressInput>,
    addressErrors: AddressErrors = {},
  ) {
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
      const form = (qty: string, label: string) =>
        `<form method="post" action="/cart/items"><input type="hidden" name="_csrf" value="${esc(formToken(req, res, d.secret))}"><input type="hidden" name="source" value="${esc(l.source_id)}"><input type="hidden" name="work" value="${esc(l.work_id)}"><input type="hidden" name="sku" value="${esc(l.sku_id)}"><input type="hidden" name="mode" value="set">${qty}<button type="submit">${label}</button></form>`;
      const remove = form('<input type="hidden" name="quantity" value="0">', 'Remove');
      if (!offer) {
        unavailable++;
        groups.get(key)!.html.push(`<div class="cart-line"><span>${esc(sku.name)}: <strong>no longer available</strong></span>${remove}</div>`);
        continue;
      }
      const lineTotal = offer.priceCents * l.quantity;
      subtotal += lineTotal;
      groups.get(key)!.html.push(
        `<div class="cart-line"><span>${esc(offer.name)} · ${usd(offer.priceCents)} each</span>${form(
          `<label for="${esc(fid)}">Quantity</label> <input id="${esc(fid)}" name="quantity" type="number" min="0" max="${maxQuantity(sku.id)}" value="${l.quantity}" required>`,
          'Update',
        )}${remove}<span>${usd(lineTotal)}</span></div>`,
      );
    }
    const kinds = new Set(lines.map((l) => d.skus.byId.get(l.sku_id)?.kind));
    const mixed = kinds.has('paper') && (kinds.has('apparel') || kinds.has('mug'));
    const head = `<h1>Your cart</h1>
${message ? `<p class="error" role="alert">${esc(message)}</p>` : ''}`;
    const body = lines.length
      ? `${head}
${[...groups.values()]
  .map((g) => `<section class="cart-group"><h2><a href="/p/${esc(g.w.source_id)}/${esc(g.w.work_id)}">${esc(g.w.title_override ?? g.w.title)}</a></h2>${g.html.join('\n')}</section>`)
  .join('\n')}
<p class="total">Subtotal: ${usd(subtotal)}</p>
${mixed ? '<p>Paper prints and apparel may arrive in separate parcels.</p>' : ''}
${unavailable ? '<p>Remove the products that are no longer available to continue.</p>' : addressForm(req, res, addressDraft ?? lastAddress(id!), addressErrors)}`
      : `${head}
<p>Your cart is empty. Pick a picture in the <a href="${ART_URL}">gallery</a>.</p>`;
    page(req, res, 'Cart · Shop', 'Your cart.', body, status);
  }

  // ---- address and quote (03 §4–5, 05 §2) ----
  const quoteDeps: QuoteDeps = { ...d.quote, catalog: d.catalog, orders: d.orders, clock: d.clock, skus: d.skus, storeLabel: d.storeLabel };
  // Each quote costs one Printful call (05 §2): limited per client.
  const quoteLimiter = perClient(10 * 60_000, 20);

  /** The last address this cart was quoted for (quotes live 7 days), to prefill the form. */
  function lastAddress(cart: string): Partial<AddressInput> {
    const q = d.orders.prepare('SELECT email, address_json FROM quotes WHERE cart_id = ? ORDER BY created_at DESC LIMIT 1').get(cart) as { email: string; address_json: string } | undefined;
    return q ? { ...(JSON.parse(q.address_json) as AddressInput), email: q.email } : {};
  }

  function addressForm(req: Request, res: Response, a: Partial<AddressInput>, errors: AddressErrors): string {
    const errs = Object.entries(errors);
    const field = ([k, label, auto]: (typeof FIELDS)[number]) => {
      const id = `a-${k}`;
      const err = errors[k] ? `<span class="error" id="${id}-err">${esc(errors[k]!)}</span>` : '';
      const describedBy = errors[k] ? ` aria-describedby="${id}-err" aria-invalid="true"` : '';
      const value = esc(String(a[k] ?? ''));
      const required = k === 'line2' ? '' : ' required';
      if (k === 'state') {
        const opts = [...US_STATES].sort().map((s) => `<option${s === a.state ? ' selected' : ''}>${s}</option>`).join('');
        return `<p><label for="${id}">${label}</label><br><select id="${id}" name="${k}" autocomplete="${auto}"${required}${describedBy}><option value="">Choose…</option>${opts}</select> ${err}</p>`;
      }
      const type = k === 'email' ? 'email' : 'text';
      const extra = k === 'zip' ? ' inputmode="numeric" maxlength="10"' : ' maxlength="100"';
      return `<p><label for="${id}">${label}</label><br><input id="${id}" name="${k}" type="${type}" autocomplete="${auto}" value="${value}"${extra}${required}${describedBy}> ${err}</p>`;
    };
    return `<h2>Ship to</h2>
<p>United States only. We use your e-mail for the receipt and updates on your order; the printer gets only the name and address.</p>
${errs.length ? `<div role="alert" class="error"><p>Please check ${errs.length === 1 ? 'one field' : `${errs.length} fields`}:</p><ul>${errs.map(([, m]) => `<li>${esc(m!)}</li>`).join('')}</ul></div>` : ''}
<form method="post" action="/cart/address" class="address">
<input type="hidden" name="_csrf" value="${esc(formToken(req, res, d.secret))}">
${FIELDS.map(field).join('\n')}
<button type="submit">See shipping and total</button>
</form>`;
  }

  r.post('/cart/address', quoteLimiter, csrf, async (req, res) => {
    const b = req.body as Record<string, string | undefined>;
    const cart = cartId(req);
    if (!cart) return res.redirect(303, '/cart');
    const { address, errors, zipMismatch } = normaliseAddress(b);
    if (!address) {
      if (zipMismatch) countZipRejection(d.orders, d.clock);
      return renderCart(req, res, cart, undefined, 422, b as Partial<AddressInput>, errors);
    }
    const result = await createQuote(quoteDeps, cart, address);
    switch (result.kind) {
      case 'ok':
        return res.redirect(303, '/quote');
      case 'empty':
        return res.redirect(303, '/cart');
      case 'unsellable':
        return renderCart(req, res, cart, 'Some products in your cart are no longer available.', 409, address);
      case 'unavailable':
        return renderCart(req, res, cart, "We can't calculate shipping right now; please try again in a few minutes.", 503, address);
      case 'cannot-ship':
        return renderCart(req, res, cart, `We can't ship this order to this address: ${result.message}`, 422, address);
    }
  });

  r.get('/quote', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const cart = cartId(req);
    const q = cart
      ? (d.orders.prepare('SELECT q.* FROM carts c JOIN quotes q ON q.id = c.quote_id WHERE c.id = ?').get(cart) as
          | { id: string; items_json: string; email: string; address_json: string; options_json: string; expires_at: string }
          | undefined)
      : undefined;
    if (!q) return res.redirect(303, '/cart');
    const items = JSON.parse(q.items_json) as QuoteItem[];
    const options = JSON.parse(q.options_json) as Array<QuoteOption & { orderable: boolean }>;
    const a = JSON.parse(q.address_json) as AddressInput;
    const expired = Date.parse(q.expires_at) <= d.clock.now();
    const subtotal = items.reduce((t, i) => t + i.unitCents * i.quantity, 0);
    const orderable = options.filter((o) => o.orderable);
    const byWork = new Map<string, QuoteItem[]>();
    for (const i of items) byWork.set(`${i.sourceId}/${i.workId}`, [...(byWork.get(`${i.sourceId}/${i.workId}`) ?? []), i]);
    const lines = [...byWork.values()]
      .map(
        (group) => `<h2>${esc(group[0].title)}</h2><table class="lines"><tbody>${group
          .map((i) => `<tr><th scope="row">${esc(i.name)}</th><td>${i.quantity} × ${usd(i.unitCents)}</td><td>${usd(i.unitCents * i.quantity)}</td></tr>`)
          .join('')}</tbody></table>`,
      )
      .join('\n');
    const days = (o: QuoteOption) => (o.minDays ? `, ${o.minDays === o.maxDays ? o.minDays : `${o.minDays}–${o.maxDays}`} business days` : '');
    const payForm = expired
      ? `<p><strong>This quote has expired.</strong></p>${requoteForm(req, res, a, q.email)}`
      : orderable.length
        ? `<form method="post" action="/checkout">
<input type="hidden" name="_csrf" value="${esc(formToken(req, res, d.secret))}">
<input type="hidden" name="quote" value="${esc(q.id)}">
<fieldset><legend>Shipping</legend>
${orderable.map((o, n) => `<label><input type="radio" name="shipping" value="${esc(o.id)}"${n === 0 ? ' checked' : ''}> ${esc(shippingLabel(o.name))}${esc(days(o))} — ${usd(o.cents)}</label><br>`).join('\n')}
</fieldset>
<p>Sales tax, if any, is calculated on the payment page.</p>
<p class="total">Total before tax: ${usd(subtotal + orderable[0].cents)} with ${esc(shippingLabel(orderable[0].name))} shipping</p>
<button type="submit">Pay with Stripe</button>
</form>`
        : "<p><strong>This combination can't be ordered right now.</strong> Please try again later, or contact us.</p>";
    page(
      req,
      res,
      'Your order · Shop',
      'Your order and its total.',
      `<h1>Your order</h1>
${lines}
<p>Items: ${usd(subtotal)}</p>
<p>Ship to ${esc(a.name)}, ${esc(a.line1)}${a.line2 ? `, ${esc(a.line2)}` : ''}, ${esc(a.city)}, ${esc(a.state)} ${esc(a.zip)}, US · <a href="/cart">Change</a></p>
${payForm}`,
    );
  });

  function requoteForm(req: Request, res: Response, a: AddressInput, email: string): string {
    const hidden = (k: string, v: string | undefined) => (v ? `<input type="hidden" name="${k}" value="${esc(v)}">` : '');
    return `<form method="post" action="/cart/address"><input type="hidden" name="_csrf" value="${esc(formToken(req, res, d.secret))}">${hidden('name', a.name)}${hidden('email', email)}${hidden('line1', a.line1)}${hidden('line2', a.line2)}${hidden('city', a.city)}${hidden('state', a.state)}${hidden('zip', a.zip)}<button type="submit">Update the quote</button></form>`;
  }

  // ---- checkout (05 §3) ----
  r.post('/checkout', perClient(10 * 60_000, 20), csrf, async (req, res) => {
    const b = req.body as Record<string, string | undefined>;
    if (!d.checkout) {
      return page(req, res, 'Payment · Shop', 'Payment.', `<h1>Payment isn't open yet</h1><p>This shop doesn't take payments yet. <a href="/cart">Back to the cart</a>.</p>`, 503);
    }
    const cart = cartId(req);
    if (!cart) return res.redirect(303, '/cart');
    const result = await startCheckout(d.checkout, cart, String(b.quote ?? ''), String(b.shipping ?? ''));
    switch (result.kind) {
      case 'redirect':
        return res.redirect(303, result.url);
      case 'no-quote':
        return res.redirect(303, '/cart');
      case 'requote':
        return renderCart(req, res, cart, 'Something in your order changed. Please check the quote again.', 409);
      case 'limits':
        return renderCart(req, res, cart, 'This order is larger than we can take online; for more, please contact us.', 409);
      case 'address':
        return renderCart(req, res, cart, result.message, 422);
      case 'unavailable':
        return page(req, res, 'Payment · Shop', 'Payment.', `<h1>Payment is unavailable right now</h1><p>Nothing was charged. Please try again in a few minutes. <a href="/quote">Back to your order</a>.</p>`, 503);
    }
  });

  // ---- order status (03 §7): the link's token becomes a cookie for this order only ----
  const ORDER_COOKIE = 'shop_order';
  const orderLimiter = perClient(60_000, 60);
  r.get('/order/find', orderLimiter, (req, res) => findPage(req, res));
  r.get('/order/:id', orderLimiter, async (req, res) => {
    const id = String(req.params.id);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex');
    if (!ORDER_ID.test(id)) return notFound(req, res);
    const t = req.query.t;
    if (t !== undefined) {
      if (!statusTokenOk(d.statusSecret, id, t)) return notFound(req, res);
      setCookie(res, ORDER_COOKIE, String(t), 365 * 24 * 60 * 60_000, `/order/${id}`);
      return res.redirect(303, `/order/${id}`);
    }
    if (!statusTokenOk(d.statusSecret, id, readCookie(req, ORDER_COOKIE))) return notFound(req, res);
    const load = () => d.orders.prepare('SELECT * FROM orders WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    let o = load();
    if (!o) return notFound(req, res);
    // Back from Stripe before the webhook: the same transition, the conditional update decides (05 §5).
    if (o.payment_state === 'checkout_open' && o.stripe_session_id && d.checkout) {
      await applyPayment(d.checkout, String(o.stripe_session_id)).catch(() => undefined);
      o = load()!;
    }
    orderPage(req, res, o);
  });

  function orderPage(req: Request, res: Response, o: Record<string, unknown>) {
    const items = d.orders.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(String(o.id)) as Array<Record<string, unknown>>;
    const parcels = d.orders
      .prepare("SELECT * FROM shipments WHERE order_id = ? AND shipment_status != 'canceled' ORDER BY shipped_at, id")
      .all(String(o.id)) as Array<Record<string, string | null>>;
    const shipped = parcels.length > 0;
    const parcelLine = (p: Record<string, string | null>, n: number) => {
      const state =
        p.delivery_status === 'delivered' ? `delivered${p.delivered_at ? ` on ${p.delivered_at.slice(0, 10)}` : ''}`
        : p.delivery_status === 'return_to_sender' || p.shipment_status === 'returned' ? 'returned to sender'
        : p.delivery_status === 'failure' ? 'delivery failed'
        : `on its way${p.estimated_to ? `, expected ${p.estimated_from && p.estimated_from !== p.estimated_to ? `${p.estimated_from} to ` : ''}${p.estimated_to}` : ''}`;
      const track = p.tracking_number
        ? p.tracking_url && /^https:\/\//.test(p.tracking_url)
          ? `, tracking <a href="${esc(p.tracking_url)}" rel="noopener noreferrer">${esc(p.tracking_number)}</a>`
          : `, tracking ${esc(p.tracking_number)}`
        : '';
      return `<li>Parcel ${n + 1}: ${esc(p.carrier ?? 'carrier')}${p.service ? ` (${esc(p.service)})` : ''}${track}; ${esc(state)}.</li>`;
    };
    const parcelList = parcels.length ? `<h2>Parcels</h2><ul class="parcels">${parcels.map(parcelLine).join('')}</ul>` : '';
    const st = customerStatus({ payment_state: String(o.payment_state), fulfilment_state: String(o.fulfilment_state), refunded_cents: Number(o.refunded_cents), shippedSomething: shipped });
    const created = new Date(String(o.created_at)).toISOString().slice(0, 10);
    const lines = items.map((i) => `<tr><th scope="row">${esc(String(i.name))}</th><td>${i.quantity} × ${usd(Number(i.unit_cents))}</td></tr>`).join('');
    const paid = o.paid_cents != null ? `<p>Paid: ${usd(Number(o.paid_cents))}${o.tax_cents ? ` (sales tax ${usd(Number(o.tax_cents))})` : ''}</p>` : '';
    const partly = o.payment_state === 'partially_refunded' ? `<p>Partly refunded: ${usd(Number(o.refunded_cents))}</p>` : '';
    const refresh = st.waiting && d.clock.now() - Date.parse(String(o.created_at)) < 2 * 60 * 60_000 ? '<meta http-equiv="refresh" content="5">' : '';
    const html = layout({
      title: `Order ${o.number} · Shop`,
      description: 'Your order.',
      testShop,
      cartCount: cartCount(req),
      body: `${refresh}<h1>Order ${esc(String(o.number))}</h1>
<p class="status" role="status"><strong>${esc(st.text)}</strong></p>
<p>Ordered on ${created}. Ships to ${esc(String(o.ship_name ?? ''))}, ${esc(String(o.ship_city ?? ''))}, ${esc(String(o.ship_state ?? ''))}.</p>
${parcelList}
<table class="lines"><tbody>${lines}</tbody></table>
<p>Shipping: ${usd(Number(o.shipping_cents))}</p>
${paid}${partly}
<p>Keep this page's address: it is your link to the order. Lost it? <a href="/order/find">Find my order</a>.</p>`,
    });
    res.type('html').send(html);
  }

  // ---- find my order (03 §8): the link is e-mailed, never shown; the same answer either way ----
  const perNumber = new Map<string, number[]>();
  function findPage(req: Request, res: Response, sent = false) {
    res.setHeader('Cache-Control', 'no-store');
    page(
      req,
      res,
      'Find my order · Shop',
      'Find your order.',
      `<h1>Find my order</h1>
${sent ? '<p role="status">If the order number and e-mail match an order, the link is on its way to that e-mail address.</p>' : ''}
<form method="post" action="/order/find">
<input type="hidden" name="_csrf" value="${esc(formToken(req, res, d.secret))}">
<p><label for="f-number">Order number</label><br><input id="f-number" name="number" inputmode="numeric" maxlength="6" required></p>
<p><label for="f-email">E-mail</label><br><input id="f-email" name="email" type="email" autocomplete="email" required></p>
<button type="submit">E-mail me the link</button>
</form>`,
    );
  }
  r.post('/order/find', perClient(10 * 60_000, 5), csrf, (req, res) => {
    const b = req.body as Record<string, string | undefined>;
    const number = String(b.number ?? '').trim();
    const email = String(b.email ?? '').trim().toLowerCase();
    // Per order number too: at most 3 requests an hour, whoever asks.
    const now = d.clock.now();
    const recent = (perNumber.get(number) ?? []).filter((t) => now - t < 60 * 60_000);
    if (/^\d{5,6}$/.test(number) && recent.length < 3) {
      perNumber.set(number, [...recent, now]);
      const o = d.orders.prepare(`SELECT id FROM orders WHERE number = ? AND email = ? AND payment_state != 'checkout_open'`).get(number, email) as { id: string } | undefined;
      if (o) queueEmail(d.orders, d.clock, o.id, 'link', String(now));
    }
    findPage(req, res, true);
  });

  r.use((req, res) => notFound(req, res));
  return r;
}
