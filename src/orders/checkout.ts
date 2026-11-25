/**
 * POST /checkout (docs/design/05 §3).
 * 1. One open checkout per cart (I9): the same quote and option → the same
 *    session; anything else → expire the old session first. An expire refused
 *    because the session is complete means the customer paid in another tab:
 *    the payment is applied and the customer goes to the order.
 * 2. Re-validate the quote against the cart and the limits.
 * 3. The order in one transaction; 4. a Stripe Customer; 5. the Checkout
 *    Session; 6. the ids stored, and the customer sent to Stripe.
 */
import type { SkuCatalog } from '../catalog-config';
import { iso, type Clock } from '../clock';
import type { FailSafeLimits } from '../config';
import { transaction, type Db } from '../db';
import { StripeError, type StripeClient } from '../payments/stripe';
import { itemsOfCart, shippingLabel, type AddressInput, type QuoteItem, type QuoteOption } from '../public/quote';
import { recordEvent } from './holds';
import { drawOrderNumber, newOrderId, statusToken } from './ids';
import { applyPayment, closeUnpaid, type PaymentDeps } from './payment';

export const SESSION_TTL_S = 30 * 60;

export interface CheckoutDeps extends PaymentDeps {
  catalog: Db;
  skus: SkuCatalog;
  storeLabel: string;
  publicUrl: string;
  statusSecret: string;
  limits: FailSafeLimits;
  automaticTax: boolean;
}

export type CheckoutResult =
  | { kind: 'redirect'; url: string }
  | { kind: 'requote' | 'no-quote' | 'unavailable' | 'limits' }
  | { kind: 'address'; message: string };

interface QuoteRow {
  id: string;
  cart_id: string;
  items_json: string;
  email: string;
  address_json: string;
  options_json: string;
  expires_at: string;
}

export function statusUrl(d: Pick<CheckoutDeps, 'publicUrl' | 'statusSecret'>, orderId: string, from?: string): string {
  return `${d.publicUrl}/order/${orderId}?t=${statusToken(d.statusSecret, orderId)}${from ? `&from=${from}` : ''}`;
}

export async function startCheckout(d: CheckoutDeps, cartId: string, quoteId: string, shippingId: string): Promise<CheckoutResult> {
  const cart = d.orders.prepare('SELECT quote_id, open_order_id FROM carts WHERE id = ?').get(cartId) as { quote_id: string | null; open_order_id: string | null } | undefined;
  if (!cart || cart.quote_id !== quoteId) return { kind: 'no-quote' };
  const quote = d.orders.prepare('SELECT * FROM quotes WHERE id = ?').get(quoteId) as QuoteRow | undefined;
  if (!quote) return { kind: 'no-quote' };
  const options = JSON.parse(quote.options_json) as Array<QuoteOption & { orderable: boolean }>;
  const option = options.find((o) => o.id === shippingId && o.orderable);
  if (!option) return { kind: 'requote' };

  // ---- 1. one open checkout per cart ----
  if (cart.open_order_id) {
    const open = d.orders.prepare('SELECT id, stripe_session_id, shipping_method, checkout_quote_id FROM orders WHERE id = ? AND payment_state = ?').get(cart.open_order_id, 'checkout_open') as
      | { id: string; stripe_session_id: string | null; shipping_method: string; checkout_quote_id: string | null }
      | undefined;
    if (open?.stripe_session_id) {
      let session;
      try {
        session = await d.stripe.getCheckoutSession(open.stripe_session_id);
      } catch {
        return { kind: 'unavailable' };
      }
      if (session.payment_status === 'paid') {
        await applyPayment(d, open.stripe_session_id);
        return { kind: 'redirect', url: statusUrl(d, open.id) };
      }
      if (session.status === 'open' && open.checkout_quote_id === quoteId && open.shipping_method === shippingId && session.url) {
        return { kind: 'redirect', url: session.url };
      }
      if (session.status === 'open') {
        try {
          await d.stripe.expireCheckoutSession(open.stripe_session_id);
        } catch (e) {
          // Refused: re-read; complete means paid in another tab (reviews A F12, B F10).
          const again = await d.stripe.getCheckoutSession(open.stripe_session_id).catch(() => undefined);
          if (again?.payment_status === 'paid') {
            await applyPayment(d, open.stripe_session_id);
            return { kind: 'redirect', url: statusUrl(d, open.id) };
          }
          if (again?.status !== 'expired') return { kind: 'unavailable' };
          void e;
        }
      }
      closeUnpaid(d.orders, d.clock, open.id, 'checkout');
    } else if (open) {
      // A checkout whose session id was lost (07 §2.1.1) is resolved by reconciliation; don't start another.
      return { kind: 'unavailable' };
    }
  }

  // ---- 2. re-validate ----
  if (Date.parse(quote.expires_at) <= d.clock.now()) return { kind: 'requote' };
  const quoted = JSON.parse(quote.items_json) as QuoteItem[];
  const now = itemsOfCart(d, cartId);
  if (now === 'unsellable' || !sameItems(quoted, now)) return { kind: 'requote' };
  const itemsCents = quoted.reduce((t, i) => t + i.unitCents * i.quantity, 0);
  const count = quoted.reduce((t, i) => t + i.quantity, 0);
  if (count > d.limits.maxItemsPerOrder || itemsCents + option.cents > d.limits.maxOrderCents) return { kind: 'limits' };
  const address = JSON.parse(quote.address_json) as AddressInput;

  // ---- 3. the order ----
  const orderId = newOrderId(d.clock);
  const idemKey = `checkout-${orderId}`;
  const number = transaction(d.orders, () => {
    const n = drawOrderNumber(d.orders);
    const ts = iso(d.clock);
    d.orders
      .prepare(
        `INSERT INTO orders (id, number, payment_state, cart_id, email, ship_name, ship_line1, ship_line2, ship_city, ship_state, ship_zip, ship_country,
           shipping_method, shipping_cents, items_cents, checkout_idempotency_key, checkout_quote_id, created_at, updated_at)
         VALUES (?, ?, 'checkout_open', ?, ?, ?, ?, ?, ?, ?, ?, 'US', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(orderId, n, cartId, quote.email, address.name, address.line1, address.line2 ?? null, address.city, address.state, address.zip, shippingId, option.cents, itemsCents, idemKey, quoteId, ts, ts);
    const ins = d.orders.prepare(
      `INSERT INTO order_items (id, order_id, source_id, work_id, sku_id, name, provider, provider_variant_id, unit_cents, quantity, print_file_sha, orientation)
       VALUES (?, ?, ?, ?, ?, ?, 'printful', ?, ?, ?, ?, ?)`,
    );
    quoted.forEach((i, k) => {
      const pf = d.catalog
        .prepare(`SELECT o.print_file_sha, o.orientation FROM offers o JOIN print_files p ON p.sha256 = o.print_file_sha AND p.deleted_at IS NULL WHERE o.source_id = ? AND o.work_id = ? AND o.sku_id = ?`)
        .get(i.sourceId, i.workId, i.skuId) as { print_file_sha: string; orientation: string | null } | undefined;
      if (!pf) throw new Error('print file missing at checkout');
      ins.run(`${orderId}-${k + 1}`, orderId, i.sourceId, i.workId, i.skuId, `${i.name} — ${i.title}`, i.variantId, i.unitCents, i.quantity, pf.print_file_sha, pf.orientation);
    });
    recordEvent(d.orders, d.clock, { orderId, part: 'payment', to: 'checkout_open', cause: 'storefront', at: ts });
    d.orders.prepare('UPDATE carts SET open_order_id = ?, updated_at = ? WHERE id = ?').run(orderId, ts, cartId);
    return n;
  });

  // ---- 4–6. Stripe ----
  const stripeAddress = { line1: address.line1, line2: address.line2, city: address.city, state: address.state, postal_code: address.zip, country: 'US' };
  try {
    const customer = await d.stripe.createCustomer(
      { email: quote.email, name: address.name, address: stripeAddress, shipping: { name: address.name, address: stripeAddress }, metadata: { order_id: orderId } },
      `customer-${orderId}`,
    );
    d.orders.prepare('UPDATE orders SET stripe_customer_id = ? WHERE id = ?').run(customer.id, orderId);
    const session = await d.stripe.createCheckoutSession(sessionParams(d, orderId, number, customer.id, quoted, option, address), idemKey);
    d.orders.prepare('UPDATE orders SET stripe_session_id = ? WHERE id = ?').run(session.id, orderId);
    if (!session.url) return { kind: 'unavailable' };
    return { kind: 'redirect', url: session.url };
  } catch (e) {
    const err = e as StripeError;
    if (err instanceof StripeError && (err.kind === 'permanent' || err.kind === 'auth' || err.kind === 'idempotency')) {
      // Stripe answered: no session exists (05 §3 errors).
      closeUnpaid(d.orders, d.clock, orderId, 'checkout');
      d.log({ level: err.kind === 'permanent' ? 'warn' : 'alert', msg: 'checkout refused by Stripe', order: orderId, code: err.code });
      if (err.code === 'customer_tax_location_invalid') return { kind: 'address', message: 'Stripe could not use this address for sales tax. Please check it.' };
      return { kind: 'unavailable' };
    }
    // No answer: the order stays checkout_open; reconciliation repeats the create with the same key (07 §2.1.1).
    d.log({ level: 'warn', msg: 'checkout: no answer from Stripe', order: orderId });
    return { kind: 'unavailable' };
  }
}

function sameItems(a: QuoteItem[], b: QuoteItem[]): boolean {
  const key = (x: QuoteItem) => `${x.sourceId}/${x.workId}/${x.skuId}/${x.quantity}/${x.unitCents}`;
  return a.length === b.length && a.map(key).sort().join() === b.map(key).sort().join();
}

function sessionParams(d: CheckoutDeps, orderId: string, number: string, customer: string, items: QuoteItem[], option: QuoteOption, a: AddressInput) {
  const shipTo = `Ships to ${a.name}, ${a.line1}${a.line2 ? `, ${a.line2}` : ''}, ${a.city}, ${a.state} ${a.zip}`;
  return {
    mode: 'payment',
    customer,
    client_reference_id: orderId,
    metadata: { order_id: orderId },
    payment_intent_data: {
      metadata: { order_id: orderId },
      description: `Order ${number}`,
      shipping: { name: a.name, address: { line1: a.line1, line2: a.line2, city: a.city, state: a.state, postal_code: a.zip, country: 'US' } },
    },
    payment_method_types: ['card', 'link'],
    line_items: items.map((i, k) => {
      const sku = d.skus.byId.get(i.skuId)!;
      const image = d.catalog
        .prepare(`SELECT path FROM display_images WHERE source_id = ? AND work_id = ? AND format = 'jpeg' ORDER BY width_px LIMIT 1`)
        .get(i.sourceId, i.workId) as { path: string } | undefined;
      return {
        quantity: i.quantity,
        price_data: {
          currency: 'usd',
          unit_amount: i.unitCents,
          tax_behavior: 'exclusive',
          product_data: {
            name: `${i.name} — ${i.title}`.slice(0, 250),
            images: image ? [`${d.publicUrl}${image.path}`] : undefined,
            tax_code: sku.taxCode,
            metadata: { order_item_id: `${orderId}-${k + 1}` },
          },
        },
      };
    }),
    shipping_options: [
      {
        shipping_rate_data: {
          type: 'fixed_amount',
          fixed_amount: { amount: option.cents, currency: 'usd' },
          display_name: shippingLabel(option.name).slice(0, 100),
          delivery_estimate: option.minDays
            ? { minimum: { unit: 'business_day', value: option.minDays }, maximum: { unit: 'business_day', value: option.maxDays ?? option.minDays } }
            : undefined,
          tax_behavior: 'exclusive',
          tax_code: 'txcd_92010001',
        },
      },
    ],
    custom_text: { submit: { message: shipTo.slice(0, 1200) } },
    billing_address_collection: 'auto',
    automatic_tax: { enabled: d.automaticTax },
    consent_collection: { terms_of_service: 'required' },
    allow_promotion_codes: false,
    expires_at: Math.floor(d.clock.now() / 1000) + SESSION_TTL_S,
    success_url: statusUrl(d, orderId, 'checkout'),
    cancel_url: `${d.publicUrl}/cart?from=checkout`,
  };
}
