/**
 * The SKU and source configuration files (docs/design/04 §2 and §4, ADR-0022,
 * ADR-0035), validated at startup. A malformed file stops the start: these are
 * deployed with the image, so an error is a release error.
 */
import { readFileSync } from 'node:fs';
import type { Mode } from './config';

export type SkuKind = 'paper' | 'mug' | 'apparel';

export interface Sku {
  id: string;
  name: string;
  kind: SkuKind;
  provider: 'printful';
  productId: number;
  /** Variant per orientation; `any` when one variant serves both. */
  variants: Record<'any' | 'portrait' | 'landscape', number | undefined>;
  printAreaIn: [number, number];
  dpi: number;
  taxCode: string;
  priceCents: number;
  placeholderPrice: boolean;
}

export interface SkuCatalog {
  minDpiPaper: number;
  skus: Sku[];
  byId: Map<string, Sku>;
}

export interface SourceConfig {
  id: string;
  default: boolean;
  adapter: string;
  publicUrl: string;
  clusterUrl?: string;
  creator?: string;
  printsAllowedDefault: boolean;
  printsAllowedWorks: string[];
}

export class CatalogConfigError extends Error {
  constructor(file: string, readonly problems: string[]) {
    super(`${file}:\n- ${problems.join('\n- ')}`);
    this.name = 'CatalogConfigError';
  }
}

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const posInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new CatalogConfigError(path, [`unreadable or not JSON (${(e as Error).message})`]);
  }
}

export function parseSkus(raw: unknown, mode: Mode, file = 'skus.json'): SkuCatalog {
  const problems: string[] = [];
  const doc = raw as { minDpiPaper?: unknown; skus?: unknown };
  if (!posInt(doc?.minDpiPaper)) problems.push('minDpiPaper must be a positive integer');
  if (!Array.isArray(doc?.skus) || doc.skus.length === 0) {
    throw new CatalogConfigError(file, [...problems, 'skus must be a non-empty list']);
  }
  const byId = new Map<string, Sku>();
  doc.skus.forEach((s: Record<string, unknown>, i: number) => {
    const at = `skus[${i}]${typeof s?.id === 'string' ? ` (${s.id})` : ''}`;
    if (typeof s?.id !== 'string' || !ID.test(s.id)) problems.push(`${at}: id must be lower-case letters, digits and hyphens`);
    else if (byId.has(s.id)) problems.push(`${at}: duplicate id`);
    if (typeof s?.name !== 'string' || !s.name.trim()) problems.push(`${at}: name is required`);
    if (!['paper', 'mug', 'apparel'].includes(s?.kind as string)) problems.push(`${at}: kind must be paper, mug or apparel`);
    if (s?.provider !== 'printful') problems.push(`${at}: provider must be printful`);
    if (!posInt(s?.productId)) problems.push(`${at}: productId must be a positive integer`);
    const v = s?.variants as Record<string, unknown> | undefined;
    const variantKeys = v && typeof v === 'object' ? Object.keys(v) : [];
    if (
      variantKeys.length === 0 ||
      !variantKeys.every((k) => ['any', 'portrait', 'landscape'].includes(k) && posInt(v![k])) ||
      (!('any' in v!) && !('portrait' in v! && 'landscape' in v!))
    ) {
      problems.push(`${at}: variants must give "any", or both "portrait" and "landscape", as positive integers`);
    }
    const area = s?.printAreaIn as unknown[];
    if (!Array.isArray(area) || area.length !== 2 || !area.every((x) => typeof x === 'number' && x > 0)) {
      problems.push(`${at}: printAreaIn must be [width, height] in inches`);
    }
    if (!posInt(s?.dpi)) problems.push(`${at}: dpi must be a positive integer`);
    if (typeof s?.taxCode !== 'string' || !/^txcd_\d{8}$/.test(s.taxCode)) problems.push(`${at}: taxCode must look like txcd_00000000`);
    if (!posInt(s?.priceCents)) problems.push(`${at}: priceCents must be a positive integer`);
    if (s?.placeholderPrice !== undefined && typeof s.placeholderPrice !== 'boolean') problems.push(`${at}: placeholderPrice must be true or false`);
    if (mode === 'live' && s?.placeholderPrice === true) problems.push(`${at}: placeholder price in live mode; Klaus sets the prices`);
    if (typeof s?.id === 'string' && !byId.has(s.id)) {
      byId.set(s.id, {
        ...(s as unknown as Sku),
        variants: { any: v?.any as number, portrait: v?.portrait as number, landscape: v?.landscape as number },
        placeholderPrice: s.placeholderPrice === true,
      });
    }
  });
  if (problems.length) throw new CatalogConfigError(file, problems);
  return { minDpiPaper: doc.minDpiPaper as number, skus: [...byId.values()], byId };
}

export function parseSources(raw: unknown, file = 'sources.json'): SourceConfig[] {
  const problems: string[] = [];
  const list = (raw as { sources?: unknown })?.sources;
  if (!Array.isArray(list) || list.length === 0) throw new CatalogConfigError(file, ['sources must be a non-empty list']);
  const ids = new Set<string>();
  const out: SourceConfig[] = [];
  list.forEach((s: Record<string, unknown>, i: number) => {
    const at = `sources[${i}]${typeof s?.id === 'string' ? ` (${s.id})` : ''}`;
    if (typeof s?.id !== 'string' || !ID.test(s.id)) problems.push(`${at}: id must be lower-case letters, digits and hyphens`);
    else if (ids.has(s.id)) problems.push(`${at}: duplicate id`);
    else ids.add(s.id);
    if (typeof s?.adapter !== 'string' || !s.adapter) problems.push(`${at}: adapter is required`);
    if (typeof s?.publicUrl !== 'string' || !s.publicUrl.startsWith('https://')) problems.push(`${at}: publicUrl must be https`);
    if (s?.clusterUrl !== undefined && (typeof s.clusterUrl !== 'string' || !/^https?:\/\//.test(s.clusterUrl))) problems.push(`${at}: clusterUrl must be a URL`);
    if (typeof s?.printsAllowedDefault !== 'boolean') problems.push(`${at}: printsAllowedDefault must be true or false`);
    const works = s?.printsAllowedWorks ?? [];
    if (!Array.isArray(works) || !works.every((w) => typeof w === 'string' && w.trim())) problems.push(`${at}: printsAllowedWorks must be a list of work ids`);
    out.push({
      id: s?.id as string,
      default: s?.default === true,
      adapter: s?.adapter as string,
      publicUrl: s?.publicUrl as string,
      clusterUrl: s?.clusterUrl as string | undefined,
      creator: s?.creator as string | undefined,
      printsAllowedDefault: s?.printsAllowedDefault === true,
      printsAllowedWorks: Array.isArray(works) ? (works as string[]) : [],
    });
  });
  if (out.filter((s) => s.default).length !== 1) problems.push('exactly one source must be the default (its works keep the /p/<work> alias)');
  if (problems.length) throw new CatalogConfigError(file, problems);
  return out;
}

export function loadSkus(path: string, mode: Mode): SkuCatalog {
  return parseSkus(readJson(path), mode, path);
}

export function loadSources(path: string): SourceConfig[] {
  return parseSources(readJson(path), path);
}

/**
 * Consent to print a work (ADR-0035): the source's own per-work flag when it
 * publishes one, else the allow-list in this file, else the source default.
 */
export function printsAllowed(source: SourceConfig, workId: string, sourceFlag?: boolean): boolean {
  if (sourceFlag !== undefined) return sourceFlag;
  if (source.printsAllowedWorks.includes(workId)) return true;
  return source.printsAllowedDefault;
}
