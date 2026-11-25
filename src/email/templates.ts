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

/** A piece of an e-mail, rendered to HTML (escaped) and to text separately: nothing is parsed back. */
type Block = { p: string } | { list: string[] } | { link: { label: string; url: string }; before?: string };

function render(blocks: Block[]): { html: string; text: string } {
  const html = blocks
    .map((b) =>
      'p' in b
        ? `<p>${esc(b.p)}</p>`
        : 'list' in b
          ? `<ul>${b.list.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`
          : `<p>${esc(b.before ?? '')}<a href="${esc(b.link.url)}" style="color: #0b57d0;">${esc(b.link.label)}</a></p>`,
    )
    .join('\n');
  const text = blocks
    .map((b) => ('p' in b ? b.p : 'list' in b ? b.list.map((i) => `- ${i}`).join('\n') : `${b.before ?? ''}${b.link.label} (${b.link.url})`))
    .join('\n\n');
  return { html, text };
}

function wrap(title: string, shop: string, blocks: Block[], statusUrl: string): { html: string; text: string } {
  const footer = `${shop}. You get this e-mail because you ordered from us; we send no marketing.`;
  const body = render([...blocks, { link: { label: 'See your order', url: statusUrl } }]);
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title></head>
<body style="font-family: system-ui, sans-serif; line-height: 1.5; color: #1a1a1a; background: #ffffff; max-width: 36rem; margin: 0 auto; padding: 1rem;">
<h1 style="font-size: 1.25rem;">${esc(title)}</h1>
${body.html}
<p style="color: #555; font-size: 0.875rem;">${esc(footer)}</p>
</body></html>`;
  return { html, text: `${title}\n\n${body.text}\n\n${footer}\n` };
}

const itemList = (o: OrderView): Block => ({ list: o.items.map((i) => `${i.name}: ${i.quantity} × ${$(i.unitCents)}`) });

export function confirmationEmail(o: OrderView, shop: string, statusUrl: string): Email {
  const title = `Thank you: order ${o.number}`;
  const body = wrap(title, shop, [
    { p: `We have your payment for order ${o.number}.` },
    itemList(o),
    { p: `Items ${$(o.itemsCents)}, shipping ${$(o.shippingCents)}${o.taxCents ? `, sales tax ${$(o.taxCents)}` : ''}; paid ${$(o.paidCents)}.` },
    { p: `Ships to ${o.shipName}, ${o.shipCity}, ${o.shipState}.` },
    { p: 'What happens next: your prints are made to order. We e-mail you when each parcel ships, with its tracking link.' },
  ], statusUrl);
  return { subject: `Your order ${o.number}`, ...body };
}

export function shippedEmail(o: OrderView, p: ParcelView, shop: string, statusUrl: string): Email {
  const title = `Order ${o.number} has shipped`;
  const blocks: Block[] = [{ p: `A parcel is on its way${p.carrier ? ` with ${p.carrier}${p.service ? ` (${p.service})` : ''}` : ''}.` }];
  if (p.trackingNumber) {
    blocks.push(p.trackingUrl && /^https:\/\//.test(p.trackingUrl) ? { before: 'Tracking: ', link: { label: p.trackingNumber, url: p.trackingUrl } } : { p: `Tracking number: ${p.trackingNumber}` });
  }
  if (p.estimatedTo) blocks.push({ p: `Expected ${p.estimatedFrom && p.estimatedFrom !== p.estimatedTo ? `between ${p.estimatedFrom} and ${p.estimatedTo}` : `by ${p.estimatedTo}`}.` });
  if (p.items.length) blocks.push({ p: 'In this parcel:' }, { list: p.items });
  if (p.more) blocks.push({ p: 'The rest of your order follows separately.' });
  const body = wrap(title, shop, blocks, statusUrl);
  return { subject: `Shipped: order ${o.number}`, ...body };
}

export function delayedEmail(o: OrderView, shop: string, statusUrl: string): Email {
  const title = `Order ${o.number} is delayed`;
  const body = wrap(title, shop, [
    { p: "Your order is taking longer than it should. We're on it, and we'll e-mail you as soon as it ships, or refund you if we can't make it." },
  ], statusUrl);
  return { subject: `Delayed: order ${o.number}`, ...body };
}

export function refundedEmail(o: OrderView, shop: string, statusUrl: string, somethingShipped: boolean): Email {
  const title = `Order ${o.number} is refunded`;
  const body = wrap(title, shop, [
    { p: `We have refunded ${$(o.refundedCents)} to your card. It usually shows within 5 to 10 business days.` },
    somethingShipped
      ? { p: 'Part of your order had already shipped and may still arrive.' }
      : { p: `We couldn't produce this order, so nothing will ship${o.items.length > 1 ? ', including the other items in it' : ''}. We're sorry.` },
  ], statusUrl);
  return { subject: `Refunded: order ${o.number}`, ...body };
}

export function linkEmail(o: Pick<OrderView, 'number'>, shop: string, statusUrl: string): Email {
  const title = `Your link to order ${o.number}`;
  const body = wrap(title, shop, [{ p: 'You asked for the link to your order. It works without a password; keep this e-mail.' }], statusUrl);
  return { subject: `Your order ${o.number}: the link`, ...body };
}
