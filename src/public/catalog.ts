/**
 * What the public pages may show (docs/design/03 §2–3, 04 §3): works and their
 * sellable offers. Sellable means everything in `readiness` holds.
 */
import type { Sku, SkuCatalog } from '../catalog-config';
import { readiness, type OfferRow } from '../catalog/offers';
import type { WorkRow } from '../catalog/works';
import type { Db } from '../db';

export interface PublicOffer {
  sku: Sku;
  /** "Art print 12 × 16 in, landscape" */
  name: string;
  priceCents: number;
  mockupPath?: string;
}

export interface DisplayImageRow {
  path: string;
  width_px: number;
  height_px: number;
  format: 'webp' | 'jpeg';
}

export function getWork(catalog: Db, sourceId: string, workId: string): WorkRow | undefined {
  return catalog.prepare('SELECT * FROM works WHERE source_id = ? AND work_id = ? AND listed = 1').get(sourceId, workId) as WorkRow | undefined;
}

export function displayImages(catalog: Db, w: Pick<WorkRow, 'source_id' | 'work_id'>): DisplayImageRow[] {
  return catalog
    .prepare('SELECT path, width_px, height_px, format FROM display_images WHERE source_id = ? AND work_id = ? ORDER BY width_px')
    .all(w.source_id, w.work_id) as unknown as DisplayImageRow[];
}

export function offerName(sku: Sku, orientation: string | null): string {
  return sku.kind === 'paper' && orientation ? `${sku.name}, ${orientation}` : sku.name;
}

export function sellableOffers(catalog: Db, skus: SkuCatalog, storeLabel: string, w: WorkRow): PublicOffer[] {
  const offers = catalog.prepare('SELECT * FROM offers WHERE source_id = ? AND work_id = ? AND enabled = 1').all(w.source_id, w.work_id) as unknown as OfferRow[];
  const out: PublicOffer[] = [];
  for (const sku of skus.skus) {
    const o = offers.find((x) => x.sku_id === sku.id);
    if (!o || !readiness(catalog, storeLabel, w, sku, o).sellable) continue;
    out.push({
      sku,
      name: offerName(sku, o.orientation),
      priceCents: o.price_cents ?? sku.priceCents,
      mockupPath: o.mockup_sha ? `/mockups/${o.mockup_sha}.jpg` : undefined,
    });
  }
  return out;
}

/** Work ids of a source with at least one sellable offer (GET /api/offers). */
export function sellableWorkIds(catalog: Db, skus: SkuCatalog, storeLabel: string, sourceId: string): string[] {
  const works = catalog
    .prepare('SELECT * FROM works WHERE source_id = ? AND listed = 1 AND enabled = 1 AND prints_allowed = 1 ORDER BY work_id')
    .all(sourceId) as unknown as WorkRow[];
  return works.filter((w) => sellableOffers(catalog, skus, storeLabel, w).length > 0).map((w) => w.work_id);
}
