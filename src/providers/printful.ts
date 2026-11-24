/**
 * The Printful adapter (docs/design/06 §3), API v2 (ADR-0005). Token of the
 * mode's store (ADR-0029), 15 s timeout, rate-limit headers read on every
 * response. Error messages are Printful's own (captured 2026-11-24), shown in
 * the admin, never parsed for behaviour except the duplicate external id.
 */
import { parseCents } from '../money';
import {
  ProviderError,
  type Address,
  type FulfilmentProvider,
  type ItemRef,
  type MockupRequest,
  type MockupTask,
  type ProviderFile,
  type ShippingRate,
  type StoreIdentity,
  type VariantSpec,
} from './types';

export interface PrintfulOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface RateLimitState {
  remaining?: number;
  resetMs?: number;
}

type Json = Record<string, unknown>;

export class PrintfulClient implements FulfilmentProvider {
  readonly id = 'printful' as const;
  readonly rateLimit: RateLimitState = {};
  private readonly fetch: typeof fetch;
  private readonly timeoutMs: number;
  private readonly base: string;

  constructor(private readonly opts: PrintfulOptions) {
    this.fetch = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.base = opts.baseUrl.replace(/\/+$/, '');
  }

  async identity(): Promise<StoreIdentity> {
    const stores = (await this.call('GET', '/v2/stores')).data as Array<{ id: number; name: string }>;
    const scopes = (await this.call('GET', '/v2/oauth-scopes')).data as Array<{ value: string }>;
    return { stores: stores.map((s) => ({ id: String(s.id), name: s.name })), scopes: scopes.map((s) => s.value) };
  }

  async describeVariant(variantId: number): Promise<VariantSpec> {
    const v = (await this.call('GET', `/v2/catalog-variants/${variantId}`)).data as Json;
    const prices = (await this.call('GET', `/v2/catalog-variants/${variantId}/prices?currency=USD`)).data as Json;
    const avail = (await this.call('GET', `/v2/catalog-variants/${variantId}/availability`)).data as Json;

    const techniques = ((prices.variant as Json)?.techniques ?? []) as Array<{ technique_key: string; price: string; discounted_price?: string }>;
    const technique = techniques[0];
    if (!technique) throw new ProviderError('permanent', `variant ${variantId}: no technique with a price`);
    const regions = ((avail.techniques ?? []) as Array<{ technique: string; selling_regions: Array<{ name: string; availability: string }> }>)
      .filter((t) => t.technique === technique.technique_key)
      .flatMap((t) => t.selling_regions);
    const dims = (v.placement_dimensions ?? []) as Array<{ placement: string; width: number; height: number; orientation?: string }>;
    return {
      variantId,
      productId: Number(v.catalog_product_id),
      name: String(v.name),
      placements: dims.map((d) => ({
        placement: d.placement,
        orientation: d.orientation === 'horizontal' || d.orientation === 'vertical' ? d.orientation : 'any',
        widthIn: Number(d.width),
        heightIn: Number(d.height),
      })),
      technique: technique.technique_key,
      available: regions.some((r) => r.name === 'usa' && r.availability === 'in stock'),
      wholesaleCents: parseCents(technique.discounted_price ?? technique.price),
    };
  }

  async shippingRates(to: Address, items: ItemRef[]): Promise<ShippingRate[]> {
    const recipient: Json = { country_code: to.countryCode, state_code: to.stateCode, zip: to.zip };
    if (to.city) recipient.city = to.city;
    if (to.address1) recipient.address1 = to.address1;
    if (to.address2) recipient.address2 = to.address2;
    // ADR-0031: no name, no e-mail, no phone; rates need only the place.
    const body = {
      recipient,
      order_items: items.map((i) => ({ source: 'catalog', catalog_variant_id: i.variantId, quantity: i.quantity })),
      currency: 'USD',
    };
    const res = await this.call('POST', '/v2/shipping-rates', body, { idempotent: true });
    return (res.data as Array<Json>).map((r) => ({
      id: String(r.shipping),
      name: String(r.shipping_method_name).trim(),
      cents: parseCents(String(r.rate)),
      minDays: typeof r.min_delivery_days === 'number' ? r.min_delivery_days : undefined,
      maxDays: typeof r.max_delivery_days === 'number' ? r.max_delivery_days : undefined,
      parcels: Array.isArray(r.shipments) ? r.shipments.length : 1,
    }));
  }

  async registerFile(url: string): Promise<ProviderFile> {
    // Printful de-duplicates by URL (captured), so a repeated call is harmless:
    // a lost answer is retried, not looked up.
    const res = await this.call('POST', '/v2/files', { role: 'printfile', url, visible: false }, { idempotent: true });
    return toFile(res.data as Json);
  }

  async getFile(providerFileId: string): Promise<ProviderFile> {
    if (!/^\d{1,20}$/.test(providerFileId)) throw new ProviderError('permanent', 'malformed file id');
    return toFile((await this.call('GET', `/v2/files/${providerFileId}`)).data as Json);
  }

  async createMockup(req: MockupRequest): Promise<MockupTask> {
    const product: Json = {
      source: 'catalog',
      catalog_product_id: req.productId,
      catalog_variant_ids: [req.variantId],
      placements: [{ placement: req.placement, technique: req.technique, layers: [{ type: 'file', url: req.fileUrl }] }],
    };
    if (req.orientation) product.orientation = req.orientation;
    // A lost answer means at worst one unused task at Printful: safe to repeat.
    const res = await this.call('POST', '/v2/mockup-tasks', { format: 'jpg', mockup_width_px: 1000, products: [product] }, { idempotent: true });
    return toMockupTask((res.data as Json[])[0]);
  }

  async getMockup(taskId: string): Promise<MockupTask> {
    if (!/^\d{1,20}$/.test(taskId)) throw new ProviderError('permanent', 'malformed mockup task id');
    const res = await this.call('GET', `/v2/mockup-tasks?id=${taskId}`);
    const task = (res.data as Json[])[0];
    if (!task) throw new ProviderError('permanent', `mockup task ${taskId} not found`);
    return toMockupTask(task);
  }

  async downloadMockup(url: string, maxBytes: number): Promise<Buffer> {
    if (!url.startsWith('https://') && !url.startsWith(this.base)) throw new ProviderError('permanent', 'mockup URL is not https');
    let res: Response;
    try {
      res = await this.fetch(url, { signal: AbortSignal.timeout(this.timeoutMs), redirect: 'follow' });
    } catch (e) {
      throw new ProviderError('unavailable', `mockup download: no answer (${(e as Error).name})`);
    }
    if (!res.ok) throw new ProviderError(res.status >= 500 ? 'unavailable' : 'permanent', `mockup download answered ${res.status}`, res.status);
    const type = res.headers.get('content-type') ?? '';
    if (!type.startsWith('image/')) throw new ProviderError('permanent', `mockup download has type ${type || 'none'}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new ProviderError('permanent', 'mockup larger than the limit');
    return buf;
  }

  /**
   * One request. `idempotent` marks a POST that is safe to repeat; any other
   * POST without an answer is `unknown`.
   */
  private async call(method: 'GET' | 'POST', path: string, body?: unknown, opts: { idempotent?: boolean } = {}): Promise<Json> {
    const reading = method === 'GET' || opts.idempotent;
    let res: Response;
    try {
      res = await this.fetch(this.base + path, {
        method,
        headers: {
          authorization: `Bearer ${this.opts.token}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error',
      });
    } catch (e) {
      throw new ProviderError(reading ? 'unavailable' : 'unknown', `printful: no answer (${(e as Error).name}) for ${method} ${route(path)}`);
    }
    this.readRateLimit(res.headers);
    const text = await res.text();
    let json: Json | undefined;
    try {
      json = text ? (JSON.parse(text) as Json) : undefined;
    } catch {
      json = undefined;
    }
    if (res.ok && json) return json;
    const message = errorMessage(json) ?? `HTTP ${res.status}`;
    if (res.status === 429) {
      const after = Number(res.headers.get('retry-after'));
      throw new ProviderError('rate_limited', `printful: rate limited`, 429, Number.isFinite(after) && after > 0 ? after * 1000 : 60_000);
    }
    if (res.status === 401 || res.status === 403) throw new ProviderError('auth', `printful: ${message}`, res.status);
    if (res.status >= 500 || res.ok) throw new ProviderError(reading ? 'unavailable' : 'unknown', `printful: ${message}`, res.status);
    if (/External ID validation error/i.test(message)) throw new ProviderError('already_exists', `printful: ${message}`, res.status);
    throw new ProviderError('permanent', `printful: ${message}`, res.status);
  }

  private readRateLimit(h: Headers): void {
    const remaining = Number(h.get('x-ratelimit-remaining'));
    const reset = Number(h.get('x-ratelimit-reset'));
    if (Number.isFinite(remaining) && h.has('x-ratelimit-remaining')) this.rateLimit.remaining = remaining;
    if (Number.isFinite(reset) && h.has('x-ratelimit-reset')) this.rateLimit.resetMs = reset * 1000;
  }
}

function errorMessage(json: Json | undefined): string | undefined {
  const err = json?.error as Json | undefined;
  if (typeof err?.message === 'string') return err.message;
  if (typeof json?.data === 'string') return json.data;
  return undefined;
}

/** Paths in errors without ids that could be long or odd. */
function route(path: string): string {
  return path.replace(/\?.*$/, '').replace(/\/\d+/g, '/{id}');
}

function toMockupTask(d: Json): MockupTask {
  const status = d.status === 'completed' || d.status === 'failed' ? d.status : 'pending';
  const urls = ((d.catalog_variant_mockups ?? []) as Array<{ mockups?: Array<{ mockup_url?: string }> }>)
    .flatMap((v) => v.mockups ?? [])
    .map((m) => m.mockup_url)
    .filter((u): u is string => typeof u === 'string');
  const failures = ((d.failure_reasons ?? []) as unknown[]).map((f) => (typeof f === 'string' ? f : JSON.stringify(f)));
  return { id: String(d.id), status, urls, failures };
}

function toFile(d: Json): ProviderFile {
  const status = d.status === 'ok' || d.status === 'failed' ? d.status : 'waiting';
  return {
    id: String(d.id),
    status,
    width: typeof d.width === 'number' ? d.width : undefined,
    height: typeof d.height === 'number' ? d.height : undefined,
  };
}
