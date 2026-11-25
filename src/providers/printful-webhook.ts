/**
 * Printful webhook deliveries (docs/design/06 §3, §5): verification and the
 * few fields the shop reads. Everything else is re-fetched from the API.
 *
 * - `x-pf-webhook-signature`: hex HMAC-SHA256 of the raw body, keyed with the
 *   hex-decoded `secret_key` of the webhook configuration;
 * - `x-pf-webhook-public-key` must be the configured public key;
 * - the body's `store_id` must be this mode's store; `occurred_at` within 24 h;
 * - event id: SHA-256 of `type|occurred_at|order id|shipment id`, 32 hex.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface PrintfulEvent {
  eventId: string;
  type: string;
  occurredAt: string;
  storeId: string;
  providerOrderId?: string;
  externalId?: string;
  shipmentId?: string;
}

export type WebhookCheck = { ok: true; event: PrintfulEvent } | { ok: false; reason: string };

const MAX_AGE_MS = 24 * 60 * 60_000;

export function signPrintfulWebhook(raw: Buffer, secretHex: string): string {
  return createHmac('sha256', Buffer.from(secretHex, 'hex')).update(raw).digest('hex');
}

export function verifyPrintfulWebhook(
  raw: Buffer,
  headers: { signature?: string; publicKey?: string },
  cfg: { secretHex: string; publicKey: string; storeId: string },
  nowMs: number,
): WebhookCheck {
  if (!headers.signature || !headers.publicKey) return { ok: false, reason: 'headers missing' };
  const pk = Buffer.from(headers.publicKey);
  const want = Buffer.from(cfg.publicKey);
  if (pk.length !== want.length || !timingSafeEqual(pk, want)) return { ok: false, reason: 'public key' };
  const sig = Buffer.from(headers.signature, 'hex');
  const expected = Buffer.from(signPrintfulWebhook(raw, cfg.secretHex), 'hex');
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return { ok: false, reason: 'signature' };
  let body: { type?: unknown; occurred_at?: unknown; store_id?: unknown; data?: { order?: { id?: unknown; external_id?: unknown }; shipment?: { id?: unknown } } };
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    return { ok: false, reason: 'not JSON' };
  }
  if (typeof body.type !== 'string' || typeof body.occurred_at !== 'string') return { ok: false, reason: 'shape' };
  if (String(body.store_id) !== cfg.storeId) return { ok: false, reason: 'store' };
  const at = Date.parse(body.occurred_at);
  if (!Number.isFinite(at) || Math.abs(nowMs - at) > MAX_AGE_MS) return { ok: false, reason: 'stale' };
  const orderId = body.data?.order?.id != null ? String(body.data.order.id) : undefined;
  const externalId = typeof body.data?.order?.external_id === 'string' ? body.data.order.external_id : undefined;
  const shipmentId = body.data?.shipment?.id != null ? String(body.data.shipment.id) : undefined;
  const eventId = createHash('sha256').update([body.type, body.occurred_at, orderId ?? '', shipmentId ?? ''].join('|')).digest('hex').slice(0, 32);
  return {
    ok: true,
    event: { eventId, type: body.type, occurredAt: body.occurred_at, storeId: String(body.store_id), providerOrderId: orderId, externalId, shipmentId },
  };
}
