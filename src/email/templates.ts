/**
 * The customer e-mails (docs/design/09 §1): plain, accessible HTML and a text
 * part, no images, no tracking, no marketing. Every e-mail carries the status
 * link. One vocabulary with the status page (07 §2.6).
 */
import { formatCents } from '../money';
import { esc } from '../pages';

export interface OrderView {
  number: string;
  shipName: string;
  shipCity: string;
  shipState: string;
  items: Array<{ name: string; quantity: number; unitCents: number }>;
  itemsCents: number;
  shippingCents: number;
  taxCents: number;
  paidCents: number;
  refundedCents: number;
}

export interface ParcelView {
  carrier: string | null;
  service: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  estimatedFrom: string | null;
  estimatedTo: string | null;
  items: string[];
  /** More parcels are expected. */
  more: boolean;
}

export interface Email {
  subject: string;
  text: string;
  html: string;
}

const $ = (c: number) => `$${formatCents(c)}`;

function wrap(title: string, shop: string, paragraphs: string[], statusUrl: string): { html: string; text: string } {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title></head>
<body style="font-family: system-ui, sans-serif; line-height: 1.5; color: #1a1a1a; background: #ffffff; max-width: 36rem; margin: 0 auto; padding: 1rem;">
<h1 style="font-size: 1.25rem;">${esc(title)}</h1>
${paragraphs.join('\n')}
<p><a href="${esc(statusUrl)}" style="color: #0b57d0;">See your order</a></p>
<p style="color: #555; font-size: 0.875rem;">${esc(shop)}. You get this e-mail because you ordered from us; we send no marketing.</p>
</body></html>`;
  const text = `${title}\n\n${paragraphs.map(toText).join('\n\n')}\n\nSee your order: ${statusUrl}\n\n${shop}. You get this e-mail because you ordered from us; we send no marketing.\n`;
  return { html, text };
}

/** HTML paragraphs to plain text: tags dropped, entities back, lists as lines. */
function toText(p: string): string {
  return p
    .replace(/<\/p>/g, '\n')
    .replace(/<ul>/g, '\n')
    .replace(/<li>/g, '- ')
    .replace(/<\/(li|tr)>/g, '\n')
    .replace(/<\/t[dh]>/g, '  ')
    .replace(/<a href="([^"]+)"[^>]*>([^<]*)<\/a>/g, '$2 ($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function itemList(o: OrderView): string {
  return `<ul>${o.items.map((i) => `<li>${esc(i.name)}: ${i.quantity} × ${$(i.unitCents)}</li>`).join('')}</ul>`;
}

export function confirmationEmail(o: OrderView, shop: string, statusUrl: string): Email {
  const title = `Thank you: order ${o.number}`;
  const body = wrap(title, shop, [
    `<p>We have your payment for order ${esc(o.number)}.</p>`,
    itemList(o),
    `<p>Items ${$(o.itemsCents)}, shipping ${$(o.shippingCents)}${o.taxCents ? `, sales tax ${$(o.taxCents)}` : ''}; paid ${$(o.paidCents)}.</p>`,
    `<p>Ships to ${esc(o.shipName)}, ${esc(o.shipCity)}, ${esc(o.shipState)}.</p>`,
    `<p>What happens next: your prints are made to order. We e-mail you when each parcel ships, with its tracking link.</p>`,
  ], statusUrl);
  return { subject: `Your order ${o.number}`, ...body };
}

export function shippedEmail(o: OrderView, p: ParcelView, shop: string, statusUrl: string): Email {
  const title = `Order ${o.number} has shipped`;
  const track = p.trackingNumber
    ? p.trackingUrl && /^https:\/\//.test(p.trackingUrl)
      ? `<p>Tracking: <a href="${esc(p.trackingUrl)}">${esc(p.trackingNumber)}</a></p>`
      : `<p>Tracking number: ${esc(p.trackingNumber)}</p>`
    : '';
  const est = p.estimatedTo ? `<p>Expected ${p.estimatedFrom && p.estimatedFrom !== p.estimatedTo ? `between ${esc(p.estimatedFrom)} and ${esc(p.estimatedTo)}` : `by ${esc(p.estimatedTo)}`}.</p>` : '';
  const body = wrap(title, shop, [
    `<p>A parcel is on its way${p.carrier ? ` with ${esc(p.carrier)}${p.service ? ` (${esc(p.service)})` : ''}` : ''}.</p>`,
    track,
    est,
    p.items.length ? `<p>In this parcel:</p><ul>${p.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : '',
    p.more ? '<p>The rest of your order follows separately.</p>' : '',
  ].filter(Boolean), statusUrl);
  return { subject: `Shipped: order ${o.number}`, ...body };
}

export function delayedEmail(o: OrderView, shop: string, statusUrl: string): Email {
  const title = `Order ${o.number} is delayed`;
  const body = wrap(title, shop, [
    `<p>Your order is taking longer than it should. We're on it, and we'll e-mail you as soon as it ships, or refund you if we can't make it.</p>`,
  ], statusUrl);
  return { subject: `Delayed: order ${o.number}`, ...body };
}

export function refundedEmail(o: OrderView, shop: string, statusUrl: string, somethingShipped: boolean): Email {
  const title = `Order ${o.number} is refunded`;
  const body = wrap(title, shop, [
    `<p>We have refunded ${$(o.refundedCents)} to your card. It usually shows within 5 to 10 business days.</p>`,
    somethingShipped
      ? '<p>Part of your order had already shipped and may still arrive.</p>'
      : `<p>We couldn't produce this order, so nothing will ship${o.items.length > 1 ? ', including the other items in it' : ''}. We're sorry.</p>`,
  ], statusUrl);
  return { subject: `Refunded: order ${o.number}`, ...body };
}

export function linkEmail(o: Pick<OrderView, 'number'>, shop: string, statusUrl: string): Email {
  const title = `Your link to order ${o.number}`;
  const body = wrap(title, shop, [`<p>You asked for the link to your order. It works without a password; keep this e-mail.</p>`], statusUrl);
  return { subject: `Your order ${o.number}: the link`, ...body };
}
