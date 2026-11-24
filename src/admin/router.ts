/**
 * The admin (docs/design/08): where Klaus sets things up, never a step in
 * processing an order. Every request needs a valid session whose e-mail is in
 * ALLOWED_EMAILS now; every change is a POST with a CSRF token from the same
 * origin, and goes to `admin_audit`.
 */
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { iso, type Clock } from '../clock';
import type { Mode } from '../config';
import { transaction, type Db } from '../db';
import { enqueue } from '../jobs';
import { esc } from '../pages';
import { csrfOk, csrfToken, readCookie, SESSION_COOKIE, verifySession, type Session } from './session';
import { adminLayout, postButton } from './views';

export interface AdminDeps {
  catalog: Db;
  orders: Db;
  clock: Clock;
  mode: Mode;
  cookieSecret?: string;
  allowedEmails: string[];
  publicUrl: string;
}

type AdminRequest = Request & { session?: Session; csrf?: string };

export function adminRouter(d: AdminDeps): Router {
  const r = express.Router();
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

  r.get('/', (_req, res) => {
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
        return `<li class="work">${thumb}<div><strong>${esc(String(w.title_override ?? w.title))}</strong> <span class="muted">${esc(String(w.source_id))} · ${esc(String(w.kind ?? ''))} · ${esc(size)}</span><br>${w.enabled ? '<span class="tag">Enabled</span> ' : ''}${action}</div></li>`;
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
  r.post('/works/:source/:work/enable', setEnabled(1));
  r.post('/works/:source/:work/disable', setEnabled(0));

  return r;
}
