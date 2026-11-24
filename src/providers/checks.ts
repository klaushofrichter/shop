/**
 * Checks against the provider (docs/design/06 §3, 04 §2).
 *
 * - Identity at startup: the token's store must be the mode's expected store,
 *   with the scopes the shop needs. A **wrong** answer stops the start; **no**
 *   answer starts the shop with the provider unverified (review C F2).
 * - The catalog check: every configured SKU's variant exists, belongs to the
 *   product, has the configured print area and is in stock in the USA.
 */
import type { Sku } from '../catalog-config';
import { ProviderError, type FulfilmentProvider, type VariantSpec } from './types';

export const REQUIRED_SCOPES = ['orders', 'file_library', 'webhooks'];

export class StartupRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StartupRefused';
  }
}

export type Verification = { state: 'verified'; storeId: string } | { state: 'unverified'; reason: string };

/**
 * `expectedStore` is required in test and live mode (config); in mock mode the
 * token must simply see exactly one store.
 */
export async function verifyIdentity(provider: FulfilmentProvider, expectedStore: string | undefined): Promise<Verification> {
  let identity;
  try {
    identity = await provider.identity();
  } catch (e) {
    if (e instanceof ProviderError && e.kind === 'auth') throw new StartupRefused(`Printful refused the token (${e.message})`);
    if (e instanceof ProviderError && (e.kind === 'unavailable' || e.kind === 'rate_limited')) {
      return { state: 'unverified', reason: e.message };
    }
    throw new StartupRefused(`Printful identity check failed: ${(e as Error).message}`);
  }
  if (identity.stores.length !== 1) throw new StartupRefused(`the Printful token sees ${identity.stores.length} stores, expected exactly one`);
  const store = identity.stores[0];
  if (expectedStore !== undefined && store.id !== expectedStore) throw new StartupRefused('the Printful token belongs to another store than this mode expects');
  const missing = REQUIRED_SCOPES.filter((s) => !identity.scopes.includes(s));
  if (missing.length) throw new StartupRefused(`the Printful token lacks the scopes ${missing.join(', ')}`);
  return { state: 'verified', storeId: store.id };
}

export interface SkuCheck {
  skuId: string;
  ok: boolean;
  wholesaleCents?: number;
  problem?: string;
}

const close = (a: number, b: number) => Math.abs(a - b) < 0.01;

/** Compare one SKU with the provider's answer. */
export function compareSku(sku: Sku, spec: VariantSpec): SkuCheck {
  const problems: string[] = [];
  if (spec.productId !== sku.productId) problems.push(`variant belongs to product ${spec.productId}, configured ${sku.productId}`);
  if (!spec.available) problems.push('not in stock in the USA');
  const [w, h] = sku.printAreaIn;
  const placement = sku.kind === 'apparel' ? 'front' : 'default';
  const areas = spec.placements.filter((p) => p.placement === placement);
  const fits = areas.some((p) => (close(p.widthIn, w) && close(p.heightIn, h)) || (close(p.widthIn, h) && close(p.heightIn, w)));
  if (!fits) problems.push(`print area ${w} × ${h} in not offered on placement ${placement}`);
  if (sku.kind === 'paper') {
    // Both orientations (ADR-0033): Printful lists one area per orientation.
    const orientations = new Set(areas.map((a) => a.orientation));
    if (!(orientations.has('any') || (orientations.has('vertical') && orientations.has('horizontal')))) {
      problems.push('not offered in both orientations');
    }
  }
  return problems.length
    ? { skuId: sku.id, ok: false, wholesaleCents: spec.wholesaleCents, problem: problems.join('; ') }
    : { skuId: sku.id, ok: true, wholesaleCents: spec.wholesaleCents };
}

/** Where the design goes on the product, and how it is printed. */
export function placementFor(sku: Sku): { placement: string; technique: string } {
  if (sku.kind === 'apparel') return { placement: 'front', technique: 'dtg' };
  if (sku.kind === 'mug') return { placement: 'default', technique: 'sublimation' };
  return { placement: 'default', technique: 'digital' };
}

/** The variant a SKU uses for an orientation. */
export function variantFor(sku: Sku, orientation: 'portrait' | 'landscape'): number {
  const v = sku.variants[orientation] ?? sku.variants.any;
  if (!v) throw new Error(`SKU ${sku.id} has no variant for ${orientation}`);
  return v;
}
