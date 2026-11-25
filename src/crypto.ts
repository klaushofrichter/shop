/** The two primitives every signed cookie, token and webhook check uses. */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** HMAC-SHA256 as base64url. */
export const mac = (secret: string, data: string): string => createHmac('sha256', secret).update(data).digest('base64url');

/** Constant-time string equality (unequal lengths are unequal). */
export function sameString(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
