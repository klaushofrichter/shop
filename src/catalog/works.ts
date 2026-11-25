/**
 * Works from content sources in catalog.db (docs/design/04 §4–6).
 *
 * - `refreshSource` stores the allow-listed fields of every listed work, hides
 *   works the source no longer lists (offers kept), and returns the enabled
 *   works whose original needs a check.
 * - `checkOriginal` downloads an original, hashes it and, only when the hash
 *   changed, renders new display images (review 2 F4). Print files and
 *   mockups follow in later steps.
 */
import { iso, type Clock } from '../clock';
import { printsAllowed, type SourceConfig } from '../catalog-config';
import { transaction, type Db } from '../db';
import { renderDisplayImages, probe, type ImageLimits } from '../images/display';
import type { FileStore } from '../images/store';
import type { ContentSource, Work } from '../sources/types';

export const MAX_ORIGINAL_BYTES = 100 * 1024 * 1024;

export interface WorkRow {
  source_id: string;
  work_id: string;
  title: string;
  title_override: string | null;
  creator: string | null;
  year: string | null;
  kind: string | null;
  canonical_url: string;
  original_url: string;
  original_sha256: string | null;
  original_px_w: number | null;
  original_px_h: number | null;
  source_version: string | null;
  prints_allowed: number;
  enabled: number;
  listed: number;
  seen_at: string;
}

export interface RefreshResult {
  listed: number;
  hidden: number;
  problems: string[];
  /** Enabled works whose original must be (re)checked. */
  toCheck: Array<{ sourceId: string; workId: string }>;
}

export async function refreshSource(db: Db, clock: Clock, config: SourceConfig, source: ContentSource): Promise<RefreshResult> {
  const { works, problems } = await source.listWorks();
  const now = iso(clock);
  return transaction(db, () => {
    const upsert = db.prepare(`
      INSERT INTO works (source_id, work_id, title, creator, year, kind, canonical_url, original_url,
                         source_version, prints_allowed, seen_at, listed, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT (source_id, work_id) DO UPDATE SET
        title = excluded.title, creator = excluded.creator, year = excluded.year, kind = excluded.kind,
        canonical_url = excluded.canonical_url, original_url = excluded.original_url,
        source_version = excluded.source_version, prints_allowed = excluded.prints_allowed,
        seen_at = excluded.seen_at, listed = 1`);
    const before = new Map(
      (db.prepare('SELECT work_id, source_version, original_sha256, enabled FROM works WHERE source_id = ?').all(config.id) as Array<
        Pick<WorkRow, 'work_id' | 'source_version' | 'original_sha256' | 'enabled'>
      >).map((r) => [r.work_id, r]),
    );
    const toCheck: RefreshResult['toCheck'] = [];
    for (const w of works) {
      const allowed = printsAllowed(config, w.workId, w.printsAllowedBySource) ? 1 : 0;
      // A new work starts enabled when it may be printed (ADR-0040); the admin's switch-off sticks.
      upsert.run(w.sourceId, w.workId, w.title, w.creator ?? null, w.year ?? null, w.kind, w.canonicalUrl, w.original.url, w.original.version, allowed, now, allowed);
      const old = before.get(w.workId);
      if (old ? old.enabled && (old.source_version !== w.original.version || !old.original_sha256) : allowed) {
        toCheck.push({ sourceId: w.sourceId, workId: w.workId });
      }
    }
    const listedIds = new Set(works.map((w) => w.workId));
    const hide = db.prepare('UPDATE works SET listed = 0 WHERE source_id = ? AND work_id = ?');
    let hidden = 0;
    for (const id of before.keys()) {
      if (!listedIds.has(id)) hidden += Number(hide.run(config.id, id).changes);
    }
    return { listed: works.length, hidden, problems, toCheck };
  });
}

export interface CheckResult {
  changed: boolean;
  sha256: string;
}

export async function checkOriginal(
  db: Db,
  source: ContentSource,
  store: FileStore,
  limits: ImageLimits,
  sourceId: string,
  workId: string,
): Promise<CheckResult> {
  const row = db.prepare('SELECT * FROM works WHERE source_id = ? AND work_id = ?').get(sourceId, workId) as WorkRow | undefined;
  if (!row) throw new Error(`unknown work ${sourceId}/${workId}`);
  const original = { url: row.original_url, version: row.source_version ?? '' } satisfies Work['original'];
  const { body, contentType, contentLength } = await source.fetchOriginal({ original });
  if (contentType !== 'image/jpeg' && contentType !== 'image/png') {
    body.destroy();
    throw new Error(`original has type ${contentType || 'none'}`);
  }
  if (contentLength && contentLength > MAX_ORIGINAL_BYTES) {
    body.destroy();
    throw new Error('original larger than the limit');
  }
  const dl = await store.download(body, MAX_ORIGINAL_BYTES);
  try {
    const hasImages = db.prepare('SELECT 1 FROM display_images WHERE source_id = ? AND work_id = ? LIMIT 1').get(sourceId, workId);
    if (row.original_sha256 === dl.sha256 && hasImages) return { changed: false, sha256: dl.sha256 };
    const { width, height } = await probe(dl.file, limits);
    const images = await renderDisplayImages(dl.file, store, limits);
    transaction(db, () => {
      db.prepare('DELETE FROM display_images WHERE source_id = ? AND work_id = ?').run(sourceId, workId);
      const ins = db.prepare(
        `INSERT OR REPLACE INTO display_images (sha256, source_id, work_id, width_px, height_px, format, path) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const im of images) ins.run(im.sha256, sourceId, workId, im.widthPx, im.heightPx, im.format, im.path);
      db.prepare('UPDATE works SET original_sha256 = ?, original_px_w = ?, original_px_h = ? WHERE source_id = ? AND work_id = ?').run(
        dl.sha256,
        width,
        height,
        sourceId,
        workId,
      );
    });
    return { changed: row.original_sha256 !== dl.sha256, sha256: dl.sha256 };
  } finally {
    store.discard(dl.file);
  }
}
