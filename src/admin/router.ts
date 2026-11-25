/**
 * The admin (docs/design/08): where Klaus sets things up, never a step in
 * processing an order. Every request needs a valid session whose e-mail is in
 * ALLOWED_EMAILS now; every change is a POST with a CSRF token from the same
 * origin, and goes to `admin_audit`.
 */
import express, { type NextFunction, type Response, type Router } from 'express';
import { perClient } from '../limiter';
import { iso, type Clock } from '../clock';
import type { Mode, QuoteSettings } from '../config';
import { transaction, type Db } from '../db';
import { enqueue } from '../jobs';
import { esc } from '../pages';
import { csrfOk, csrfToken, readCookie, SESSION_COOKIE, verifySession } from './session';
import type { SkuCatalog } from '../catalog-config';
import { anchorOf, previewPlan, readiness, type OfferRow } from '../catalog/offers';
import type { WorkRow } from '../catalog/works';
import { ANCHORS, type Anchor } from '../images/printfile';
import { formatCents, parseCents, usd } from '../money';
import { adminLayout, postButton } from './views';
import { holdsSection, registerOrderRoutes, type AdminRequest } from './orders';

export interface AdminDeps {
  catalog: Db;
  orders: Db;
  clock: Clock;
  mode: Mode;
  cookieSecret?: string;
  allowedEmails: string[];
  publicUrl: string;
  skus: SkuCatalog;
  /** Whose file registrations count for readiness: the mode. */
  storeLabel: string;
  /** Stripe's fee estimate on the order page. */
  quote?: QuoteSettings;
}

const ANCHOR_LABELS: Record<Anchor, string> = {
  nw: 'top left', n: 'top', ne: 'top right', w: 'left', c: 'centre', e: 'right', sw: 'bottom left', s: 'bottom', se: 'bottom right',
};
const MAX_PRICE_CENTS = 1_000_000;


export function adminRouter(d: AdminDeps): Router {
  const r = express.Router();
  r.use(perClient(60_000, 300));
  r.use(express.urlencoded({ extended: false, limit: '32kb' }));

  r.use((req: AdminRequest, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    const session = d.cookieSecret ? verifySession(d.cookieSecret, readCookie(req, SESSION_COOKIE), d.clock) : undefined;
    if (!session || !d.allowedEmails.includes(session.email)) {
      if (req.method === 'GET') return res.redirect(303, '/admin/login');
      return res.status(403).type('text').send('not signed in');
    }
    req.session = session;
    req.csrf = csrfToken(d.cookieSecret!, session);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // Same origin (browsers send Origin on POST) and the session's CSRF token.
      const origin = req.get('origin');
      const site = req.get('sec-fetch-site');
      if ((origin && origin !== new URL(d.publicUrl).origin) || (site && site !== 'same-origin')) {
        return res.status(403).type('text').send('cross-site request refused');
      }
      if (!csrfOk(d.cookieSecret!, session, (req.body as Record<string, unknown>)?._csrf)) {
        return res.status(403).type('text').send('form expired; reload the page');
      }
    }
    next();
  });

  const page = (res: Response, title: string, body: string) =>
    res.type('html').send(adminLayout({ title, body, mode: d.mode, signedIn: true }));

  const audit = (req: AdminRequest, action: string, target: string, details?: unknown) =>
    d.orders
      .prepare('INSERT INTO admin_audit (at, actor, action, target, details_json) VALUES (?, ?, ?, ?, ?)')
      .run(iso(d.clock), req.session!.email, action, target, details === undefined ? null : JSON.stringify(details));

  registerOrderRoutes(r, { orders: d.orders, clock: d.clock, mode: d.mode, quote: d.quote }, page, audit);

  r.get('/', (req: AdminRequest, res) => {
    const count = (db: Db, sql: string) => (db.prepare(sql).get() as { n: number }).n;
    const works = count(d.catalog, 'SELECT COUNT(*) n FROM works WHERE listed = 1');
    const enabled = count(d.catalog, 'SELECT COUNT(*) n FROM works WHERE listed = 1 AND enabled = 1');
    const allowed = count(d.catalog, 'SELECT COUNT(*) n FROM works WHERE listed = 1 AND prints_allowed = 1');
    const failedJobs = count(d.orders, "SELECT COUNT(*) n FROM jobs WHERE state = 'failed'");
    const skuBad = d.catalog.prepare('SELECT sku_id, problem FROM sku_checks WHERE ok = 0 ORDER BY sku_id').all() as Array<{ sku_id: string; problem: string }>;
    page(
      res,
      'Dashboard',
      `<h1>Dashboard</h1>
<ul class="facts">
<li>Works listed by the sources: ${works}; prints allowed: ${allowed}; enabled: ${enabled}. <a href="/admin/works">Works</a></li>
<li>Failed jobs: ${failedJobs}</li>
</ul>
${holdsSection({ orders: d.orders, clock: d.clock, mode: d.mode }, req.csrf!)}
${skuBad.length ? `<h2>Products switched off by the catalog check</h2><ul>${skuBad.map((s) => `<li>${esc(s.sku_id)}: ${esc(s.problem ?? '')}</li>`).join('')}</ul>` : ''}`,
    );
  });

  r.get('/works', (req: AdminRequest, res) => {
    const rows = d.catalog
      .prepare(
        `SELECT w.*, (SELECT path FROM display_images i WHERE i.source_id = w.source_id AND i.work_id = w.work_id AND i.format = 'webp' ORDER BY width_px LIMIT 1) AS thumb
         FROM works w WHERE listed = 1 ORDER BY source_id, prints_allowed DESC, title`,
      )
      .all() as Array<Record<string, string | number | null>>;
    const items = rows
      .map((w) => {
        const id = `${w.source_id}/${w.work_id}`;
        const size = w.original_px_w ? `${w.original_px_w} × ${w.original_px_h} px` : 'original not fetched yet';
        const action = !w.prints_allowed
          ? '<span class="muted">Prints not allowed by the source</span>'
          : postButton(`/admin/works/${id}/${w.enabled ? 'disable' : 'enable'}`, w.enabled ? 'Disable' : 'Enable', req.csrf!);
        const thumb = w.thumb ? `<img src="${esc(String(w.thumb))}" alt="" width="96" height="96" loading="lazy">` : '<span class="thumb-none" aria-hidden="true"></span>';
        return `<li class="work">${thumb}<div><a href="/admin/works/${esc(id)}"><strong>${esc(String(w.title_override ?? w.title))}</strong></a> <span class="muted">${esc(String(w.source_id))} · ${esc(String(w.kind ?? ''))} · ${esc(size)}</span><br>${w.enabled ? '<span class="tag">Enabled</span> ' : ''}${action}</div></li>`;
      })
      .join('\n');
    page(res, 'Works', `<h1>Works</h1>${rows.length ? `<ul class="works">${items}</ul>` : '<p>No works yet: the sources are read every 10 minutes.</p>'}`);
  });

  const setEnabled = (enabled: 0 | 1) => (req: AdminRequest, res: Response) => {
    const { source, work } = req.params as { source: string; work: string };
    const row = d.catalog.prepare('SELECT prints_allowed, enabled FROM works WHERE source_id = ? AND work_id = ? AND listed = 1').get(source, work) as
      | { prints_allowed: number; enabled: number }
      | undefined;
    if (!row) return res.status(404).type('text').send('no such work');
    if (enabled && !row.prints_allowed) return res.status(409).type('text').send('prints of this work are not allowed by its source');
    transaction(d.catalog, () => d.catalog.prepare('UPDATE works SET enabled = ? WHERE source_id = ? AND work_id = ?').run(enabled, source, work));
    audit(req, enabled ? 'work.enable' : 'work.disable', `${source}/${work}`);
    // An enabled work needs its original checked and its display images rendered.
    if (enabled) enqueue(d.orders, d.clock, 'work.original', `${source}/${work}`, { sourceId: source, workId: work });
    res.redirect(303, '/admin/works');
  };
  r.get('/works/:source/:work', (req: AdminRequest, res) => {
    const { source, work } = req.params as { source: string; work: string };
    const w = d.catalog.prepare('SELECT * FROM works WHERE source_id = ? AND work_id = ?').get(source, work) as WorkRow | undefined;
    if (!w) return res.status(404).type('text').send('no such work');
    const img = d.catalog
      .prepare(`SELECT path, width_px, height_px FROM display_images WHERE source_id = ? AND work_id = ? AND format = 'webp' ORDER BY width_px LIMIT 1`)
      .get(source, work) as { path: string; width_px: number; height_px: number } | undefined;
    const offers = new Map(
      (d.catalog.prepare('SELECT * FROM offers WHERE source_id = ? AND work_id = ?').all(source, work) as unknown as OfferRow[]).map((o) => [o.sku_id, o]),
    );
    const checks = new Map(
      (d.catalog.prepare('SELECT sku_id, ok, wholesale_cents FROM sku_checks').all() as Array<{ sku_id: string; ok: number; wholesale_cents: number | null }>).map((c) => [c.sku_id, c]),
    );
    const rows = d.skus.skus
      .map((sku) => {
        const o = offers.get(sku.id);
        const anchor = anchorOf(o);
        const plan = previewPlan(w, sku, anchor, d.skus.minDpiPaper);
        const ready = readiness(d.catalog, d.storeLabel, w, sku, o);
        const price = o?.price_cents ?? sku.priceCents;
        const wholesale = checks.get(sku.id)?.wholesale_cents;
        const pf = o?.print_file_sha
          ? (d.catalog.prepare('SELECT preview_path FROM print_files WHERE sha256 = ?').get(o.print_file_sha) as { preview_path: string | null } | undefined)
          : undefined;
        const dpi = plan
          ? `${plan.effectiveDpi} DPI${plan.effectiveDpi < plan.floor ? ` — <strong>below the floor of ${plan.floor}</strong>` : ''}; crop cuts ${Math.round(plan.cut * 100)} %`
          : 'original not checked yet';
        const fid = `o-${sku.id}`;
        const anchors = ANCHORS.map(
          (a) => `<label><input type="radio" name="anchor" value="${a}"${a === anchor ? ' checked' : ''}> ${ANCHOR_LABELS[a]}</label>`,
        ).join(' ');
        return `<section class="offer" aria-labelledby="${fid}">
<h2 id="${fid}">${esc(sku.name)}</h2>
<p class="muted">${dpi}. ${wholesale ? `Printful ${formatCents(wholesale)} USD; ` : ''}${ready.sellable ? '<strong>Sellable</strong>' : `Not sellable: ${esc(ready.missing.join('; '))}`}.</p>
${pf?.preview_path ? `<img class="preview" src="${esc(pf.preview_path)}" alt="Print file preview: ${esc(sku.name)}" width="240" height="240" loading="lazy">` : ''}
${o?.mockup_sha && o.print_file_sha ? `<img class="preview" src="/mockups/${esc(String(o.mockup_sha))}.jpg" alt="Mockup: ${esc(sku.name)}" width="240" height="240" loading="lazy">` : o?.print_file_sha ? '<span class="muted">Mockup pending; the picture stands in until then.</span>' : ''}
<form method="post" action="/admin/works/${esc(source)}/${esc(work)}/offers/${esc(sku.id)}">
<input type="hidden" name="_csrf" value="${esc(req.csrf!)}">
<label><input type="checkbox" name="enabled"${o?.enabled ? ' checked' : ''}> Offer this product</label>
<span>Price ${usd(price)} <span class="muted">(per product, set in skus.json; ADR-0040)</span></span>
${sku.kind === 'paper' || sku.kind === 'mug' ? `<fieldset><legend>Crop anchor</legend>${anchors}</fieldset>` : ''}
<button type="submit">Save</button>
</form>
</section>`;
      })
      .join('\n');
    const size = w.original_px_w ? `${w.original_px_w} × ${w.original_px_h} px` : 'original not checked yet';
    page(
      res,
      w.title,
      `<p><a href="/admin/works">← Works</a></p>
<h1>${esc(w.title_override ?? w.title)}</h1>
${img ? `<img class="work-image" src="${esc(img.path)}" alt="${esc(w.title)}" width="${img.width_px}" height="${img.height_px}">` : ''}
<p class="muted">${esc(w.source_id)} · ${esc(w.kind ?? '')} · ${esc(size)} · <a href="${esc(w.canonical_url)}">at the source</a></p>
${w.enabled ? '' : '<p><strong>This work is not enabled</strong>; its offers stay unsellable until it is.</p>'}
${rows}`,
    );
  });

  r.post('/works/:source/:work/offers/:sku', (req: AdminRequest, res) => {
    const { source, work, sku: skuId } = req.params as { source: string; work: string; sku: string };
    const sku = d.skus.byId.get(skuId);
    const w = d.catalog.prepare('SELECT * FROM works WHERE source_id = ? AND work_id = ?').get(source, work) as WorkRow | undefined;
    if (!sku || !w) return res.status(404).type('text').send('no such work or product');
    const body = req.body as Record<string, string | undefined>;
    const enabled = body.enabled === 'on' ? 1 : 0;
    const anchor = (ANCHORS as readonly string[]).includes(body.anchor ?? '') ? (body.anchor as Anchor) : 'c';
    let price: number | null = null;
    try {
      const raw = (body.price ?? '').trim().replace(/^\$/, '');
      if (raw) price = parseCents(raw);
    } catch {
      return res.status(400).type('text').send('the price must be an amount like 45.00');
    }
    if (price !== null && (price <= 0 || price > MAX_PRICE_CENTS)) return res.status(400).type('text').send('the price is out of range');
    if (price === sku.priceCents) price = null; // the default stays the default
    if (enabled) {
      if (!w.prints_allowed) return res.status(409).type('text').send('prints of this work are not allowed by its source');
      const plan = previewPlan(w, sku, anchor, d.skus.minDpiPaper);
      if (!plan) return res.status(409).type('text').send('the original has not been checked yet; enable the work and wait a minute');
      if (plan.effectiveDpi < plan.floor) return res.status(409).type('text').send(`this crop gives ${plan.effectiveDpi} DPI, below the floor of ${plan.floor}`);
    }
    const before = d.catalog.prepare('SELECT * FROM offers WHERE source_id = ? AND work_id = ? AND sku_id = ?').get(source, work, skuId) as OfferRow | undefined;
    const cropJson = JSON.stringify({ anchor });
    transaction(d.catalog, () => {
      d.catalog
        .prepare(
          `INSERT INTO offers (source_id, work_id, sku_id, enabled, price_cents, crop_json) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (source_id, work_id, sku_id) DO UPDATE SET enabled = excluded.enabled, price_cents = excluded.price_cents,
             crop_json = excluded.crop_json,
             render_error = CASE WHEN offers.crop_json IS excluded.crop_json THEN offers.render_error ELSE NULL END`,
        )
        .run(source, work, skuId, enabled, price, cropJson);
    });
    audit(req, 'offer.save', `${source}/${work}/${skuId}`, { enabled, price, anchor });
    if (enabled && (!before?.print_file_sha || before.crop_json !== cropJson || !before.enabled)) {
      enqueue(d.orders, d.clock, 'offer.render', `${source}/${work}/${skuId}`, { sourceId: source, workId: work, skuId });
    }
    res.redirect(303, `/admin/works/${source}/${work}#o-${skuId}`);
  });

  r.post('/works/:source/:work/enable', setEnabled(1));
  r.post('/works/:source/:work/disable', setEnabled(0));

  return r;
}
