/**
 * The fulfilment provider interface (docs/design/06 §2, ADR-0017), the parts
 * built in step 3: identity checks, catalog, shipping rates, file library.
 * Orders, mockups and webhooks follow with steps 4 and 7.
 */
export interface Address {
  name?: string;
  address1?: string;
  address2?: string;
  city?: string;
  stateCode: string;
  zip: string;
  countryCode: string;
}

export interface ItemRef {
  variantId: number;
  quantity: number;
}

export interface ShippingRate {
  /** Provider's method id, e.g. STANDARD. */
  id: string;
  name: string;
  cents: number;
  minDays?: number;
  maxDays?: number;
  /** Parcels the order would ship in (mixed carts often split). */
  parcels: number;
}

export interface VariantSpec {
  variantId: number;
  productId: number;
  name: string;
  /** Print area per orientation, in inches. */
  placements: Array<{ placement: string; orientation: 'vertical' | 'horizontal' | 'any'; widthIn: number; heightIn: number }>;
  technique: string;
  /** Selling region USA: in stock. */
  available: boolean;
  /** Wholesale price of the variant with its default technique, in cents. */
  wholesaleCents: number;
}

export type FileStatus = 'waiting' | 'ok' | 'failed';

export interface ProviderFile {
  id: string;
  status: FileStatus;
  width?: number;
  height?: number;
}

export interface MockupRequest {
  productId: number;
  variantId: number;
  placement: string;
  technique: string;
  /** Paper only: the variant's orientation. */
  orientation?: 'vertical' | 'horizontal';
  fileUrl: string;
}

export interface MockupTask {
  id: string;
  status: 'pending' | 'completed' | 'failed';
  urls: string[];
  failures: string[];
}

export interface StoreIdentity {
  stores: Array<{ id: string; name: string }>;
  scopes: string[];
}

export interface FulfilmentProvider {
  readonly id: 'printful';
  identity(): Promise<StoreIdentity>;
  describeVariant(variantId: number): Promise<VariantSpec>;
  shippingRates(to: Address, items: ItemRef[]): Promise<ShippingRate[]>;
  registerFile(url: string): Promise<ProviderFile>;
  getFile(providerFileId: string): Promise<ProviderFile>;
  createMockup(req: MockupRequest): Promise<MockupTask>;
  getMockup(taskId: string): Promise<MockupTask>;
  /** A finished mockup image (a temporary provider URL), at most `maxBytes`. */
  downloadMockup(url: string, maxBytes: number): Promise<Buffer>;
}

/**
 * How a provider call failed (docs/design/06 §2):
 * - `unavailable`: no answer or a 5xx on a read; try again later.
 * - `unknown`: no answer or a 5xx on a create; look up before retrying.
 * - `rate_limited`: 429; `retryAfterMs` says when.
 * - `permanent`: the provider refused the request (4xx); retrying won't help.
 * - `already_exists`: a duplicate `external_id`; look the order up.
 * - `auth`: 401/403; the token is wrong or lacks a scope.
 */
export type ProviderErrorKind = 'unavailable' | 'unknown' | 'rate_limited' | 'permanent' | 'already_exists' | 'auth';

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
