/**
 * The Stripe client (docs/design/05 §3–8): form-encoded requests with bracket
 * keys, the API version pinned (the account default is 2017-04-06; captured),
 * an idempotency key on every create, 15 s timeout. Only the calls the shop
 * makes; the restricted key allows nothing else (05 §8).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const STRIPE_VERSION = '2026-11-18.endive';

export type StripeErrorKind = 'unavailable' | 'unknown' | 'rate_limited' | 'permanent' | 'idempotency' | 'auth';

export class StripeError extends Error {
  constructor(
    readonly kind: StripeErrorKind,
    message: string,
    readonly status?: number,
    readonly code?: string,
    readonly param?: string,
  ) {
    super(message);
    this.name = 'StripeError';
  }
}

type Json = Record<string, unknown>;
export type Params = Record<string, unknown>;

/** Stripe's form encoding: nested objects and arrays as bracket keys. */
export function encodeForm(params: Params, prefix = ''): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v !== null && typeof v === 'object') {
      const entries = Array.isArray(v) ? Object.fromEntries(v.map((x, i) => [String(i), x])) : (v as Params);
      out.push(...encodeForm(entries, key));
    } else {
      out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v === null ? '' : String(v))}`);
    }
  }
  return out;
}

export interface StripeOptions {
  apiBase: string;
  secretKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface CheckoutSession {
  id: string;
  status: 'open' | 'complete' | 'expired';
  payment_status: 'paid' | 'unpaid' | 'no_payment_required';
  url: string | null;
  currency: string;
  amount_subtotal: number;
  amount_total: number;
  total_details?: { amount_tax?: number; amount_shipping?: number };
  shipping_cost?: { amount_subtotal: number; amount_tax: number; amount_total: number } | null;
  client_reference_id: string | null;
  metadata?: Record<string, string>;
  customer?: string | null;
  payment_intent?: string | PaymentIntent | null;
  expires_at?: number;
}

export interface PaymentIntent {
  id: string;
  latest_charge?: string | Charge | null;
}

export interface Charge {
  id: string;
  amount: number;
  amount_refunded: number;
  payment_intent?: string | null;
  disputed?: boolean;
  outcome?: { risk_level?: string } | null;
  payment_method_details?: { card?: { fingerprint?: string } | null } | null;
}

export interface Refund {
  id: string;
  amount: number;
  charge: string;
  /** pending, requires_action, succeeded, failed, canceled */
  status: string;
  metadata?: Record<string, string>;
}

export interface Dispute {
  id: string;
  charge: string;
  /** warning_needs_response, …, needs_response, under_review, won, lost */
  status: string;
}

export interface EarlyFraudWarning {
  id: string;
  charge: string;
  actionable: boolean;
}

export interface LineItem {
  id: string;
  quantity: number;
  amount_subtotal: number;
  amount_tax: number;
  price?: { unit_amount?: number; product?: string | { metadata?: Record<string, string> } } | null;
  /** Our order item id, from price_data.product_data.metadata (review C F6). */
  orderItemId?: string;
}

/** The payment intent and charge of a session fetched with `expandCharge` (absent while unpaid). */
export function chargeOf(session: CheckoutSession): { paymentIntent?: PaymentIntent; charge?: Charge } {
  const paymentIntent = typeof session.payment_intent === 'object' ? (session.payment_intent ?? undefined) : undefined;
  const charge = typeof paymentIntent?.latest_charge === 'object' ? (paymentIntent.latest_charge ?? undefined) : undefined;
  return { paymentIntent, charge };
}

export class StripeClient {
  private readonly fetch: typeof fetch;
  private readonly timeoutMs: number;
  private readonly base: string;

  constructor(private readonly opts: StripeOptions) {
    this.fetch = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.base = opts.apiBase.replace(/\/+$/, '');
  }

  createCustomer(params: Params, idempotencyKey: string): Promise<{ id: string }> {
    return this.call<{ id: string }>('POST', '/v1/customers', params, idempotencyKey);
  }

  async deleteCustomer(id: string): Promise<void> {
    await this.call<unknown>('DELETE', `/v1/customers/${encodeURIComponent(id)}`);
  }

  createCheckoutSession(params: Params, idempotencyKey: string): Promise<CheckoutSession> {
    return this.call<CheckoutSession>('POST', '/v1/checkout/sessions', params, idempotencyKey);
  }

  getCheckoutSession(id: string, expandCharge = false): Promise<CheckoutSession> {
    const q = expandCharge ? '?expand[]=payment_intent.latest_charge' : '';
    return this.call<CheckoutSession>('GET', `/v1/checkout/sessions/${encodeURIComponent(id)}${q}`);
  }

  expireCheckoutSession(id: string): Promise<CheckoutSession> {
    return this.call<CheckoutSession>('POST', `/v1/checkout/sessions/${encodeURIComponent(id)}/expire`, {});
  }

  /** Completed sessions created since `sinceS` (unix seconds), for the reverse sweep (07 §5); paged. */
  async listCompletedSessions(sinceS: number): Promise<CheckoutSession[]> {
    const out: CheckoutSession[] = [];
    let after: string | undefined;
    for (let page = 0; page < 20; page++) {
      const q = `?limit=100&status=complete&created[gte]=${sinceS}${after ? `&starting_after=${encodeURIComponent(after)}` : ''}`;
      const res = await this.call<{ data: CheckoutSession[]; has_more: boolean }>('GET', `/v1/checkout/sessions${q}`);
      out.push(...res.data);
      if (!res.has_more || !res.data.length) return out;
      after = res.data[res.data.length - 1].id;
    }
    return out;
  }

  getCharge(id: string): Promise<Charge> {
    return this.call<Charge>('GET', `/v1/charges/${encodeURIComponent(id)}`);
  }

  /** A refund of the payment (05 §7); the key makes a repeat return the same refund for 24 h. */
  createRefund(paymentIntent: string, amountCents: number, metadata: Record<string, string>, idempotencyKey: string): Promise<Refund> {
    return this.call<Refund>('POST', '/v1/refunds', { payment_intent: paymentIntent, amount: amountCents, metadata }, idempotencyKey);
  }

  getRefund(id: string): Promise<Refund> {
    return this.call<Refund>('GET', `/v1/refunds/${encodeURIComponent(id)}`);
  }

  getDispute(id: string): Promise<Dispute> {
    return this.call<Dispute>('GET', `/v1/disputes/${encodeURIComponent(id)}`);
  }

  getEarlyFraudWarning(id: string): Promise<EarlyFraudWarning> {
    return this.call<EarlyFraudWarning>('GET', `/v1/radar/early_fraud_warnings/${encodeURIComponent(id)}`);
  }

  /** Every line item of a session, paged (review C F6), with our order item id from the product's metadata. */
  async listLineItems(sessionId: string): Promise<LineItem[]> {
    const out: LineItem[] = [];
    let after: string | undefined;
    for (let page = 0; page < 20; page++) {
      const q = `?limit=100&expand[]=data.price.product${after ? `&starting_after=${encodeURIComponent(after)}` : ''}`;
      const res = await this.call<{ data: LineItem[]; has_more: boolean }>('GET', `/v1/checkout/sessions/${encodeURIComponent(sessionId)}/line_items${q}`);
      for (const li of res.data) {
        const product = li.price?.product;
        out.push({ ...li, orderItemId: typeof product === 'object' ? product?.metadata?.order_item_id : undefined });
      }
      if (!res.has_more || !res.data.length) return out;
      after = res.data[res.data.length - 1].id;
    }
    throw new StripeError('permanent', 'too many line items');
  }

  private async call<T>(method: 'GET' | 'POST' | 'DELETE', path: string, params?: Params, idempotencyKey?: string): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.opts.secretKey}`,
      'stripe-version': STRIPE_VERSION,
      accept: 'application/json',
    };
    let body: string | undefined;
    if (params) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = encodeForm(params).join('&');
    }
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    const creating = method !== 'GET';
    let res: Response;
    try {
      res = await this.fetch(this.base + path, { method, headers, body, signal: AbortSignal.timeout(this.timeoutMs), redirect: 'error' });
    } catch (e) {
      // A create with an idempotency key is safe to repeat: still, its outcome is unknown until repeated.
      throw new StripeError(creating ? 'unknown' : 'unavailable', `stripe: no answer (${(e as Error).name}) for ${method} ${route(path)}`);
    }
    let json: Json | undefined;
    try {
      json = (await res.json()) as Json;
    } catch {
      json = undefined;
    }
    if (res.ok && json) return json as T;
    const err = (json?.error ?? {}) as { message?: string; type?: string; code?: string; param?: string };
    const message = `stripe: ${err.message ?? `HTTP ${res.status}`}`;
    if (res.status === 429) throw new StripeError('rate_limited', message, 429, err.code);
    if (res.status === 401 || res.status === 403) throw new StripeError('auth', message, res.status, err.code);
    if (res.status >= 500) throw new StripeError(creating ? 'unknown' : 'unavailable', message, res.status, err.code);
    if (err.type === 'idempotency_error') throw new StripeError('idempotency', message, res.status, err.code);
    throw new StripeError('permanent', message, res.status, err.code, err.param);
  }
}

function route(path: string): string {
  return path.replace(/\?.*$/, '').replace(/\/(cs|cus|pi|ch|re|dp|issfr)_[A-Za-z0-9_]+/g, '/$1_…');
}

/**
 * The parts of a webhook the shop uses (05 §4, review 1 F12): only these
 * three; everything else is re-fetched with the pinned version.
 */
export interface StripeEventRef {
  id: string;
  type: string;
  objectId: string;
}

/**
 * Verify `Stripe-Signature: t=…,v1=…` over the raw body (HMAC-SHA256 with the
 * endpoint's secret, 300 s tolerance). Returns the event's three fields, or
 * undefined for anything that doesn't verify.
 */
export function verifyStripeWebhook(raw: Buffer, header: string | undefined, secret: string, nowMs: number, toleranceS = 300): StripeEventRef | undefined {
  if (!header) return undefined;
  const parts = header.split(',').map((p) => p.trim().split('='));
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!Number.isFinite(t) || !sigs.length) return undefined;
  if (Math.abs(nowMs / 1000 - t) > toleranceS) return undefined;
  const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.`).update(raw).digest('hex'));
  if (!sigs.some((s) => s && s.length === expected.length && timingSafeEqual(Buffer.from(s), expected))) return undefined;
  try {
    const ev = JSON.parse(raw.toString('utf8')) as { id?: unknown; type?: unknown; data?: { object?: { id?: unknown } } };
    if (typeof ev.id !== 'string' || typeof ev.type !== 'string' || typeof ev.data?.object?.id !== 'string') return undefined;
    return { id: ev.id, type: ev.type, objectId: ev.data.object.id };
  } catch {
    return undefined;
  }
}

/** For the mock and tests: a valid signature header. */
export function signStripeWebhook(raw: string, secret: string, nowMs: number): string {
  const t = Math.floor(nowMs / 1000);
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`;
}
