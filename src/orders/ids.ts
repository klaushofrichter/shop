/**
 * Order identifiers (docs/design/07 §1).
 * - Order id: 26 characters, lower-case base32, time-ordered with a random tail.
 * - Order number: five random digits, unique (ADR-0032), shown to customers.
 * - Status token: HMAC(STATUS_TOKEN_SECRET, order id), first 128 bits,
 *   base64url; never stored, recomputed for every e-mail (ADR-0037).
 */
import { createHmac, randomInt } from 'node:crypto';
import { sameString } from '../crypto';
import type { Clock } from '../clock';
import type { Db } from '../db';

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

export function newOrderId(clock: Clock): string {
  let t = BigInt(clock.now());
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = B32[Number(t & 31n)] + time;
    t >>= 5n;
  }
  let tail = '';
  for (let i = 0; i < 16; i++) tail += B32[randomInt(32)];
  return time + tail;
}

/** Five random digits not yet used; ≤ 10 draws, then an error (an alert). */
export function drawOrderNumber(orders: Db): string {
  for (let i = 0; i < 10; i++) {
    const n = String(randomInt(10000, 100000));
    if (!orders.prepare('SELECT 1 FROM orders WHERE number = ?').get(n)) return n;
  }
  throw new Error('no free order number after 10 draws');
}

export function statusToken(secret: string, orderId: string): string {
  return createHmac('sha256', secret).update(`status:${orderId}`).digest().subarray(0, 16).toString('base64url');
}

/** The order's status link, as e-mailed and as Stripe's return address (03 §7). */
export function statusUrl(d: { publicUrl: string; statusSecret: string }, orderId: string, from?: string): string {
  return `${d.publicUrl}/order/${orderId}?t=${statusToken(d.statusSecret, orderId)}${from ? `&from=${from}` : ''}`;
}

export function statusTokenOk(secret: string, orderId: string, token: unknown): boolean {
  return typeof token === 'string' && sameString(token, statusToken(secret, orderId));
}

export const ORDER_ID = /^[a-z2-7]{26}$/;
