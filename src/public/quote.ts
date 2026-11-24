/**
 * The quote (docs/design/05 §2, ADR-0036):
 * 1. the address, checked locally: required fields, Latin script, a US state,
 *    ZIP ↔ state;
 * 2. shipping rates: one Printful call;
 * 3. the pre-payment cost check from cached wholesale prices, so a
 *    misconfigured price never reaches a payment;
 * 4. stored for 30 minutes, with the address and e-mail only here (not on the
 *    cart; review C F14).
 */
import { randomBytes } from 'node:crypto';
import type { SkuCatalog } from '../catalog-config';
import { iso, type Clock } from '../clock';
import type { QuoteSettings } from '../config';
import { getSetting, setSetting, transaction, type Db } from '../db';
import { ProviderError, type FulfilmentProvider, type ShippingRate } from '../providers/types';
import { variantFor } from '../providers/checks';
import { getWork, sellableOffers } from './catalog';
import { checkZip, US_STATES } from './zip';

export const QUOTE_TTL_MS = 30 * 60_000;

export interface AddressInput {
  name: string;
  email: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  zip: string;
}

export type AddressErrors = Partial<Record<keyof AddressInput, string>>;

const LATIN = /^[\x20-\x7E -ɏ]*$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,}$/;

/** Trimmed, whitespace collapsed, state upper-case, ZIP as 5 or 5-4 digits. */
export function normaliseAddress(raw: Record<string, unknown>): { address?: AddressInput; errors: AddressErrors } {
  const s = (k: string, max: number) => String(raw[k] ?? '').replace(/\s+/g, ' ').trim().slice(0, max + 1);
  const a: AddressInput = {
    name: s('name', 100),
    email: s('email', 254).toLowerCase(),
    line1: s('line1', 100),
    line2: s('line2', 100) || undefined,
    city: s('city', 60),
    state: s('state', 2).toUpperCase(),
    zip: s('zip', 10).replace(/^(\d{5})(\d{4})$/, '$1-$2'),
  };
  const e: AddressErrors = {};
  if (!a.name) e.name = 'Enter the name for the parcel.';
  else if (a.name.length > 100) e.name = 'The name can be at most 100 characters.';
  if (!a.email) e.email = 'Enter your e-mail address.';
  else if (!EMAIL.test(a.email)) e.email = 'Enter an e-mail address like name@example.com.';
  if (!a.line1) e.line1 = 'Enter the street address.';
  else if (a.line1.length > 100) e.line1 = 'The address line can be at most 100 characters.';
  if (a.line2 && a.line2.length > 100) e.line2 = 'The address line can be at most 100 characters.';
  if (!a.city) e.city = 'Enter the city.';
  if (!US_STATES.has(a.state)) e.state = 'Choose a US state.';
  if (!/^\d{5}(-\d{4})?$/.test(a.zip)) e.zip = 'Enter a 5-digit ZIP code.';
  for (const k of ['name', 'line1', 'line2', 'city'] as const) {
    if (a[k] && !LATIN.test(a[k]!) && !e[k]) e[k] = 'Please use Latin letters: our printer can only print those.';
  }
  if (!e.state && !e.zip && checkZip(a.state, a.zip) === 'mismatch') e.zip = `This ZIP code isn't in ${a.state}. Please check the ZIP code and the state.`;
  return Object.keys(e).length ? { errors: e } : { address: a, errors: e };
}

export interface QuoteItem {
  sourceId: string;
  workId: string;
  title: string;
  skuId: string;
  name: string;
  variantId: number;
  unitCents: number;
  quantity: number;
}

export interface QuoteOption {
  id: string;
  name: string;
  cents: number;
  minDays?: number;
  maxDays?: number;
  parcels: number;
}

export interface QuoteDeps {
  catalog: Db;
  orders: Db;
  clock: Clock;
  skus: SkuCatalog;
  storeLabel: string;
  settings: QuoteSettings;
  provider?: FulfilmentProvider;
  providerReady: () => boolean;
  log: (line: Record<string, unknown>) => void;
}

export type QuoteResult =
  | { kind: 'ok'; quoteId: string }
  | { kind: 'empty' | 'unsellable' | 'unavailable' }
  | { kind: 'cannot-ship'; message: string };

export function itemsOfCart(d: Pick<QuoteDeps, 'catalog' | 'orders' | 'skus' | 'storeLabel'>, cartId: string): QuoteItem[] | 'unsellable' {
  const lines = d.orders.prepare('SELECT source_id, work_id, sku_id, quantity FROM cart_items WHERE cart_id = ? ORDER BY source_id, work_id, sku_id').all(cartId) as Array<{
    source_id: string; work_id: string; sku_id: string; quantity: number;
  }>;
  const items: QuoteItem[] = [];
  for (const l of lines) {
    const w = getWork(d.catalog, l.source_id, l.work_id);
    const offer = w && w.enabled && w.prints_allowed ? sellableOffers(d.catalog, d.skus, d.storeLabel, w).find((o) => o.sku.id === l.sku_id) : undefined;
    if (!w || !offer) return 'unsellable';
    const o = d.catalog.prepare('SELECT orientation FROM offers WHERE source_id = ? AND work_id = ? AND sku_id = ?').get(l.source_id, l.work_id, l.sku_id) as { orientation: string | null };
    items.push({
      sourceId: l.source_id, workId: l.work_id, title: w.title_override ?? w.title, skuId: l.sku_id, name: offer.name,
      variantId: variantFor(offer.sku, o.orientation === 'landscape' ? 'landscape' : 'portrait'),
      unitCents: offer.priceCents, quantity: l.quantity,
    });
  }
  return items;
}

/**
 * The cost check (05 §2): what Printful would charge (cached wholesale ×
 * quantity, the quoted shipping, an allowance for the tax it charges on
 * wholesale) against what the customer pays for items and shipping, less
 * Stripe's fee. Customer tax is never revenue. Undefined when a price is unknown.
 */
export function estimatedMargin(
  items: QuoteItem[],
  rateCents: number,
  chargedShippingCents: number,
  wholesale: Map<string, number>,
  s: QuoteSettings,
): { estCostCents: number; marginCents: number } | undefined {
  let cost = 0;
  for (const i of items) {
    const w = wholesale.get(i.skuId);
    if (w === undefined) return undefined;
    cost += w * i.quantity;
  }
  cost += rateCents;
  cost += Math.ceil((cost * s.providerTaxAllowancePct) / 100);
  const revenue = items.reduce((t, i) => t + i.unitCents * i.quantity, 0) + chargedShippingCents;
  const fee = Math.ceil((revenue * s.stripeFeePct) / 100) + s.stripeFeeFixedCents;
  return { estCostCents: cost, marginCents: revenue - fee - cost };
}

export async function createQuote(d: QuoteDeps, cartId: string, address: AddressInput): Promise<QuoteResult> {
  const items = itemsOfCart(d, cartId);
  if (items === 'unsellable') return { kind: 'unsellable' };
  if (items.length === 0) return { kind: 'empty' };
  if (!d.provider || !d.providerReady()) return { kind: 'unavailable' };

  let rates: ShippingRate[];
  try {
    // Rates need only the place (ADR-0031): no name, no e-mail.
    rates = await d.provider.shippingRates(
      { address1: address.line1, address2: address.line2, city: address.city, stateCode: address.state, zip: address.zip, countryCode: 'US' },
      items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })),
    );
  } catch (e) {
    if (e instanceof ProviderError && e.kind === 'permanent') return { kind: 'cannot-ship', message: e.message.replace(/^printful: /, '') };
    d.log({ level: 'warn', msg: 'shipping rates unavailable', error: (e as Error).message });
    return { kind: 'unavailable' };
  }
  if (!rates.length) return { kind: 'cannot-ship', message: 'No shipping method is available for this address.' };

  const wholesale = new Map(
    (d.catalog.prepare('SELECT sku_id, wholesale_cents FROM sku_checks WHERE ok = 1 AND wholesale_cents IS NOT NULL').all() as Array<{ sku_id: string; wholesale_cents: number }>).map((r) => [r.sku_id, r.wholesale_cents]),
  );
  const sorted = [...rates].sort((a, b) => (a.id === 'STANDARD' ? -1 : b.id === 'STANDARD' ? 1 : a.cents - b.cents)).slice(0, 3);
  const options: Array<QuoteOption & { estCostCents?: number; orderable: boolean }> = sorted.map((r) => {
    const charged = r.cents + d.settings.shippingMarkupCents;
    const m = estimatedMargin(items, r.cents, charged, wholesale, d.settings);
    return { id: r.id, name: r.name, cents: charged, minDays: r.minDays, maxDays: r.maxDays, parcels: r.parcels, estCostCents: m?.estCostCents, orderable: !!m && m.marginCents >= d.settings.marginFloorCents };
  });
  if (options.some((o) => !o.orderable)) {
    // A misconfigured price, a changed wholesale price, or an unknown one: Klaus is told (alerts by e-mail with step 8).
    d.log({ level: 'alert', msg: 'cost check failed at quote', skus: items.map((i) => i.skuId), options: options.filter((o) => !o.orderable).map((o) => o.id) });
  }

  const id = randomBytes(16).toString('base64url');
  const now = d.clock.now();
  transaction(d.orders, () => {
    d.orders
      .prepare(
        `INSERT INTO quotes (id, cart_id, items_json, email, address_json, options_json, est_cost_cents, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id, cartId, JSON.stringify(items), address.email,
        JSON.stringify({ ...address, email: undefined, country: 'US' }),
        JSON.stringify(options),
        options[0]?.estCostCents ?? null,
        new Date(now + QUOTE_TTL_MS).toISOString(), iso(d.clock),
      );
    d.orders.prepare('UPDATE carts SET quote_id = ?, updated_at = ? WHERE id = ?').run(id, iso(d.clock), cartId);
  });
  return { kind: 'ok', quoteId: id };
}

export function countZipRejection(orders: Db, clock: Clock): void {
  const n = getSetting<number>(orders, 'zip_rejections') ?? 0;
  setSetting(orders, 'zip_rejections', n + 1, iso(clock));
}
