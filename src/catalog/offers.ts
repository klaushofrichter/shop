/**
 * Offers: a SKU Klaus enabled for a work (docs/design/04 §3).
 *
 * An offer is **sellable** only when all hold: the work's source allows prints
 * and Klaus enabled the work; the offer is enabled; its print file is rendered
 * and validated; its registration at the provider is `ok`; the SKU passed the
 * last catalog check.
 */
import sharp from 'sharp';
import { iso, type Clock } from '../clock';
import type { SkuCatalog, Sku } from '../catalog-config';
import { transaction, type Db } from '../db';
import type { ImageLimits } from '../images/display';
import { ANCHORS, DpiTooLow, minDpi, orientationOf, planCrop, renderPrintFile, RENDERER_VERSION, type Anchor } from '../images/printfile';
import type { FileStore } from '../images/store';
import { enqueue, PermanentJobError, RetryLater, type JobRunner } from '../jobs';
import type { ContentSource } from '../sources/types';
import { MAX_ORIGINAL_BYTES, type WorkRow } from './works';

export interface OfferRow {
  source_id: string;
  work_id: string;
  sku_id: string;
  enabled: number;
  price_cents: number | null;
  crop_json: string | null;
  orientation: string | null;
  print_file_sha: string | null;
  effective_dpi: number | null;
  cut_pct: number | null;
  render_error: string | null;
}

export function anchorOf(o: Pick<OfferRow, 'crop_json'> | undefined): Anchor {
  try {
    const a = JSON.parse(o?.crop_json ?? '{}').anchor;
    return (ANCHORS as readonly string[]).includes(a) ? a : 'c';
  } catch {
    return 'c';
  }
}

export interface Readiness {
  sellable: boolean;
  /** What is missing, in Klaus's words. */
  missing: string[];
}

export function readiness(catalog: Db, storeLabel: string, w: WorkRow, sku: Sku, offer: OfferRow | undefined): Readiness {
  const missing: string[] = [];
  if (!w.prints_allowed) missing.push('prints not allowed by the source');
  if (!w.enabled) missing.push('work not enabled');
  if (!offer?.enabled) missing.push('offer not enabled');
  if (offer?.render_error) missing.push(`print file: ${offer.render_error}`);
  else if (!offer?.print_file_sha) missing.push('print file not rendered yet');
  else {
    const pf = catalog
      .prepare(`SELECT status FROM provider_files WHERE print_file_sha = ? AND provider = 'printful' AND store = ?`)
      .get(offer.print_file_sha, storeLabel) as { status: string } | undefined;
    if (pf?.status !== 'ok') missing.push(`Printful file ${pf?.status ?? 'not registered yet'}`);
  }
  const check = catalog.prepare('SELECT ok FROM sku_checks WHERE sku_id = ?').get(sku.id) as { ok: number } | undefined;
  if (check?.ok !== 1) missing.push(check ? 'product switched off by the catalog check' : 'product not checked at Printful yet');
  return { sellable: missing.length === 0, missing };
}

/** Before rendering: the DPI and the cut this crop would give, from the original's size. */
export function previewPlan(w: WorkRow, sku: Sku, anchor: Anchor, minDpiPaper: number) {
  if (!w.original_px_w || !w.original_px_h) return undefined;
  const plan = planCrop(sku, w.original_px_w, w.original_px_h, anchor);
  return { ...plan, floor: minDpi(sku, minDpiPaper), orientation: orientationOf(w.original_px_w, w.original_px_h) };
}

export interface OfferJobDeps {
  catalog: Db;
  orders: Db;
  clock: Clock;
  sources: Map<string, ContentSource>;
  skus: SkuCatalog;
  store: FileStore;
  limits: ImageLimits;
  /** Register print files at the provider (only when a provider is configured). */
  registerFiles: boolean;
  log: (line: Record<string, unknown>) => void;
}

export function registerOfferJobs(runner: JobRunner, d: OfferJobDeps): void {
  runner.register('offer.render', {
    maxAttempts: 5,
    async run(ctx) {
      const { sourceId, workId, skuId } = ctx.payload as { sourceId: string; workId: string; skuId: string };
      const sku = d.skus.byId.get(skuId);
      if (!sku) throw new PermanentJobError(`unknown SKU ${skuId}`);
      const w = d.catalog.prepare('SELECT * FROM works WHERE source_id = ? AND work_id = ?').get(sourceId, workId) as WorkRow | undefined;
      const offer = d.catalog.prepare('SELECT * FROM offers WHERE source_id = ? AND work_id = ? AND sku_id = ?').get(sourceId, workId, skuId) as OfferRow | undefined;
      if (!w || !offer) throw new PermanentJobError('no such offer');
      if (!offer.enabled) return;
      if (!w.original_sha256 || !w.original_px_w || !w.original_px_h) throw new RetryLater(30_000, 'original not checked yet');
      const source = d.sources.get(sourceId);
      if (!source) throw new PermanentJobError(`unknown source ${sourceId}`);

      const anchor = anchorOf(offer);
      const orientation = orientationOf(w.original_px_w, w.original_px_h);
      const renderKey = [sourceId, workId, w.original_sha256, skuId, orientation, anchor, RENDERER_VERSION].join('|');
      const existing = d.catalog.prepare('SELECT sha256 FROM print_files WHERE render_key = ? AND deleted_at IS NULL').get(renderKey) as { sha256: string } | undefined;
      let sha = existing?.sha256;
      // DPI and cut follow from the original's size and the crop, rendered or reused.
      const plan = planCrop(sku, w.original_px_w, w.original_px_h, anchor);
      const effectiveDpi = plan.effectiveDpi;
      const cutPct = Math.round(plan.cut * 100);

      if (!sha) {
        const { body, contentType } = await source.fetchOriginal({ original: { url: w.original_url, version: w.source_version ?? '' } });
        if (contentType !== 'image/jpeg' && contentType !== 'image/png') {
          body.destroy();
          throw new Error(`original has type ${contentType || 'none'}`);
        }
        const dl = await d.store.download(body, MAX_ORIGINAL_BYTES);
        try {
          if (dl.sha256 !== w.original_sha256) {
            // The source changed since the last check: check it first, render after.
            enqueue(d.orders, d.clock, 'work.original', `${sourceId}/${workId}`, { sourceId, workId });
            throw new RetryLater(60_000, 'original changed');
          }
          let r;
          try {
            r = await renderPrintFile(dl.file, sku, anchor, { ...d.limits, minDpiPaper: d.skus.minDpiPaper, store: d.store });
          } catch (e) {
            if (e instanceof DpiTooLow) {
              d.catalog.prepare('UPDATE offers SET render_error = ?, effective_dpi = ? WHERE source_id = ? AND work_id = ? AND sku_id = ?').run(e.message, e.effectiveDpi, sourceId, workId, skuId);
              throw new PermanentJobError(e.message);
            }
            throw e;
          }
          const preview = await sharp(d.store.pathOf('files', `${r.sha256}.${r.ext}`), { limitInputPixels: d.limits.maxInputPixels })
            .resize({ width: 480, height: 480, fit: 'inside' })
            .flatten({ background: '#ffffff' })
            .jpeg({ quality: 80 })
            .toBuffer();
          const previewSha = d.store.put('img', 'jpg', preview);
          sha = r.sha256;
          d.catalog
            .prepare(
              `INSERT OR IGNORE INTO print_files (sha256, render_key, path, width_px, height_px, bytes, created_at, preview_path)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(sha, renderKey, `/files/${sha}.${r.ext}`, r.widthPx, r.heightPx, r.bytes, iso(d.clock), `/img/${previewSha}.jpg`);
        } finally {
          d.store.discard(dl.file);
        }
      }

      transaction(d.catalog, () => {
        d.catalog
          .prepare(
            `UPDATE offers SET print_file_sha = ?, orientation = ?, effective_dpi = ?, cut_pct = ?, render_error = NULL
             WHERE source_id = ? AND work_id = ? AND sku_id = ?`,
          )
          .run(sha!, orientation, effectiveDpi, cutPct, sourceId, workId, skuId);
      });
      if (d.registerFiles) enqueue(d.orders, d.clock, 'printfile.register', sha!, { sha });
      d.log({ level: 'info', msg: 'offer rendered', source: sourceId, work: workId, sku: skuId, reused: !!existing });
    },
  });
}
