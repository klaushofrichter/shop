/**
 * The admin session (docs/design/08 §2, ADR-0013): a cookie `shop_admin` with an
 * HMAC-signed `{email, exp}` (COOKIE_SECRET), 12 hours. Stateless: logout
 * removes the cookie in this browser; rotating COOKIE_SECRET ends every
 * session. ALLOWED_EMAILS is checked at sign-in and on every request.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import type { Clock } from '../clock';

export const SESSION_COOKIE = 'shop_admin';
export const SESSION_TTL_MS = 12 * 60 * 60_000;

export interface Session {
  email: string;
  exp: number;
}

const b64 = (s: string) => Buffer.from(s).toString('base64url');
const mac = (secret: string, data: string) => createHmac('sha256', secret).update(data).digest('base64url');

export function signSession(secret: string, s: Session): string {
  const payload = b64(JSON.stringify({ email: s.email, exp: s.exp }));
  return `${payload}.${mac(secret, `session:${payload}`)}`;
}

export function verifySession(secret: string, value: string | undefined, clock: Clock): Session | undefined {
  if (!value) return undefined;
  const [payload, sig] = value.split('.');
  if (!payload || !sig) return undefined;
  const expected = mac(secret, `session:${payload}`);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
  try {
    const s = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Session;
    if (typeof s.email !== 'string' || typeof s.exp !== 'number' || s.exp <= clock.now()) return undefined;
    return s;
  } catch {
    return undefined;
  }
}

/** A CSRF token tied to the session (double-submit: the form carries it, the cookie proves the session). */
export function csrfToken(secret: string, s: Session): string {
  return mac(secret, `csrf:${s.email}:${s.exp}`);
}

export function csrfOk(secret: string, s: Session, token: unknown): boolean {
  if (typeof token !== 'string') return false;
  const a = Buffer.from(token);
  const b = Buffer.from(csrfToken(secret, s));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Cookies from the request header, without a parser dependency. */
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

const BASE = { httpOnly: true, secure: true, sameSite: 'lax' as const };

export function setCookie(res: Response, name: string, value: string, maxAgeMs: number, path = '/'): void {
  res.cookie(name, value, { ...BASE, path, maxAge: maxAgeMs });
}

/** Cleared with the same attributes it was set with, or the browser keeps it (vault: logout). */
export function clearCookie(res: Response, name: string, path = '/'): void {
  res.clearCookie(name, { ...BASE, path });
}
