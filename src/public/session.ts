/**
 * Visitor cookies and form protection for the public pages (docs/design/03).
 *
 * - `shop_cart`: a random cart id, 30 days.
 * - `shop_csrf`: a random value; every public form carries HMAC(secret, value)
 *   (double submit), so a form posted from another site fails (review 1 F28).
 * - `shop_preview`: proof of the preview key while the gate is on (ADR-0039);
 *   it holds an HMAC of the key, never the key.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { readCookie, setCookie } from '../admin/session';

export const CART_COOKIE = 'shop_cart';
export const CSRF_COOKIE = 'shop_csrf';
export const PREVIEW_COOKIE = 'shop_preview';
export const CART_TTL_MS = 30 * 24 * 60 * 60_000;

const mac = (secret: string, data: string) => createHmac('sha256', secret).update(data).digest('base64url');
const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const ID = /^[A-Za-z0-9_-]{22,64}$/;

export function newId(): string {
  return randomBytes(18).toString('base64url');
}

/** The visitor's CSRF form token; sets the cookie on first use. */
export function formToken(req: Request, res: Response, secret: string): string {
  let v = readCookie(req, CSRF_COOKIE);
  if (!v || !ID.test(v)) {
    v = newId();
    setCookie(res, CSRF_COOKIE, v, CART_TTL_MS);
    // Make the new value visible to a later read in the same request.
    req.headers.cookie = `${req.headers.cookie ? `${req.headers.cookie}; ` : ''}${CSRF_COOKIE}=${v}`;
  }
  return mac(secret, `form:${v}`);
}

export function formTokenOk(req: Request, secret: string, token: unknown): boolean {
  const v = readCookie(req, CSRF_COOKIE);
  return typeof token === 'string' && !!v && ID.test(v) && same(token, mac(secret, `form:${v}`));
}

export function cartId(req: Request): string | undefined {
  const v = readCookie(req, CART_COOKIE);
  return v && ID.test(v) ? v : undefined;
}

export function previewProof(secret: string, key: string): string {
  return mac(secret, `preview:${key}`);
}

export function previewOk(req: Request, secret: string, key: string): boolean {
  const v = readCookie(req, PREVIEW_COOKIE);
  return !!v && same(v, previewProof(secret, key));
}

export function keyMatches(given: unknown, key: string): boolean {
  return typeof given === 'string' && same(createHmac('sha256', 'k').update(given).digest('hex'), createHmac('sha256', 'k').update(key).digest('hex'));
}
