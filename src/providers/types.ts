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
  // ---- orders (06 §2–4, step 7) ----
  /** Look an order up by its external id; null when there is none (404). */
  findOrder(externalId: string): Promise<ProviderOrder | null>;
  createDraft(order: DraftOrder): Promise<ProviderOrder>;
  getOrder(providerOrderId: string): Promise<ProviderOrder>;
  /** Absent in test mode: the test store never confirms (07 §2.9). */
  confirm?(providerOrderId: string): Promise<ProviderOrder>;
  /** v2 DELETE: allowed only for uncharged draft, failed or canceled orders, so success is I4's proof. */
  deleteOrder(providerOrderId: string): Promise<'deleted' | 'refused'>;
  /** v1 cancel of a confirmed order not yet in production. */
  cancel(providerOrderId: string): Promise<'canceled' | 'not_cancellable'>;
}

/** Normalised order status (06 §2). */
export type ProviderOrderStatus =
  | 'draft'
  | 'pending'
  | 'inreview'
  | 'on_hold'
  | 'in_production'
  | 'partially_shipped'
  | 'fulfilled'
  | 'canceled'
  | 'failed';

export interface ProviderOrder {
  id: string;
  externalId: string | null;
  storeId: string;
  status: ProviderOrderStatus;
  costs: {
    status: 'calculating' | 'done' | 'failed';
    /** What Printful charges the store: items, shipping and its taxes. */
    totalCents?: number;
  };
}

export interface DraftItem {
  /** The shop's order_items id. */
  externalId: string;
  variantId: number;
  quantity: number;
  retailCents: number;
  name: string;
  orientation?: 'horizontal' | 'vertical';
  placement: string;
  technique: string;
  fileUrl: string;
}

export interface DraftOrder {
  /** `<order id>-<attempt>` (07 §2.4). */
  externalId: string;
  shipping: string;
  /** ADR-0031: name and address only; no e-mail, no phone. */
  recipient: Required<Pick<Address, 'name' | 'address1' | 'city' | 'stateCode' | 'zip' | 'countryCode'>> & { address2?: string };
  items: DraftItem[];
  retail: { shippingCents: number; taxCents: number };
  /** The shop's own contact on the slip (06 §3), never the customer's. */
  packingSlip: { storeName: string; email?: string; phone?: string; customOrderId: string };
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
