/**
 * Google sign-in for the admin (docs/design/08 §2, the cluster's hand-rolled
 * pattern): `state`, a PKCE verifier and a `nonce` in short-lived cookies;
 * the code exchanged with the verifier; the ID token verified for our client
 * and checked for the nonce, a verified e-mail and ALLOWED_EMAILS.
 * `/admin/login` is a 200 page, never a bounce to Google, so logout stays
 * logged out.
 */
import { randomBytes } from 'node:crypto';
import express, { type Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import type { Clock } from '../clock';
import { adminLayout } from './views';
import { clearCookie, readCookie, SESSION_COOKIE, SESSION_TTL_MS, setCookie, signSession } from './session';

const FLOW_COOKIE = 'shop_oauth';
const FLOW_TTL_MS = 10 * 60_000;

/** What the callback needs from Google: exchange a code, verify an ID token. Replaced in tests. */
export interface GoogleSignIn {
  authUrl(state: string, nonce: string, codeChallenge: string): string;
  codeVerifier(): Promise<{ codeVerifier: string; codeChallenge: string }>;
  /** Returns the verified token's claims, or throws. */
  exchange(code: string, codeVerifier: string): Promise<{ email?: string; email_verified?: boolean; nonce?: string }>;
}

export function googleSignIn(clientId: string, clientSecret: string, redirectUri: string): GoogleSignIn {
  const client = new OAuth2Client({ clientId, clientSecret, redirectUri });
  return {
    authUrl: (state, nonce, codeChallenge) =>
      client.generateAuthUrl({
        scope: ['openid', 'email'],
        state,
        nonce,
        code_challenge_method: CodeChallengeMethod.S256,
        code_challenge: codeChallenge,
        prompt: 'select_account',
      }),
    codeVerifier: () => client.generateCodeVerifierAsync().then((v) => ({ codeVerifier: v.codeVerifier, codeChallenge: v.codeChallenge! })),
    async exchange(code, codeVerifier) {
      const { tokens } = await client.getToken({ code, codeVerifier });
      if (!tokens.id_token) throw new Error('no ID token');
      const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: clientId });
      const p = ticket.getPayload();
      return { email: p?.email, email_verified: p?.email_verified, nonce: p?.nonce };
    },
  };
}

export interface AuthDeps {
  google?: GoogleSignIn;
  cookieSecret?: string;
  allowedEmails: string[];
  clock: Clock;
  log: (line: Record<string, unknown>) => void;
}

export function authRouter(d: AuthDeps): Router {
  const r = express.Router();
  // Sign-in is a handful of requests a day; anything more is someone guessing.
  const limiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false });
  r.use(['/admin/login', '/auth/google', '/auth/logout'], limiter);

  r.get('/admin/login', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(
      adminLayout({
        title: 'Sign in',
        body: d.google
          ? `<h1>Shop admin</h1><p><a class="button" href="/auth/google/login">Sign in with Google</a></p>`
          : `<h1>Shop admin</h1><p>Sign-in is not configured in this environment.</p>`,
      }),
    );
  });

  r.get('/auth/google/login', async (_req, res) => {
    if (!d.google) return res.status(503).type('text').send('sign-in is not configured');
    const state = randomBytes(24).toString('base64url');
    const nonce = randomBytes(24).toString('base64url');
    const { codeVerifier, codeChallenge } = await d.google.codeVerifier();
    setCookie(res, FLOW_COOKIE, JSON.stringify({ state, nonce, codeVerifier }), FLOW_TTL_MS, '/auth/google');
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, d.google.authUrl(state, nonce, codeChallenge));
  });

  r.get('/auth/google/callback', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const refuse = (why: string) => {
      d.log({ level: 'warn', msg: 'admin sign-in refused', why });
      clearCookie(res, FLOW_COOKIE, '/auth/google');
      res.status(403).type('html').send(adminLayout({ title: 'Not signed in', body: `<h1>Not signed in</h1><p>${why}. <a href="/admin/login">Try again</a>.</p>` }));
    };
    if (!d.google || !d.cookieSecret) return res.status(503).type('text').send('sign-in is not configured');
    let flow: { state?: string; nonce?: string; codeVerifier?: string } = {};
    try {
      flow = JSON.parse(readCookie(req, FLOW_COOKIE) ?? '{}');
    } catch {
      /* treated as missing */
    }
    const { code, state } = req.query;
    if (typeof state !== 'string' || !flow.state || state !== flow.state) return refuse('The sign-in request has expired or did not start here');
    if (typeof code !== 'string' || !flow.codeVerifier) return refuse('Google returned no code');
    let claims;
    try {
      claims = await d.google.exchange(code, flow.codeVerifier);
    } catch {
      return refuse('Google could not confirm the sign-in');
    }
    if (claims.nonce !== flow.nonce) return refuse('The sign-in answer does not match the request');
    const email = claims.email?.trim().toLowerCase();
    if (!email || claims.email_verified !== true || !d.allowedEmails.includes(email)) return refuse('This account is not allowed');
    clearCookie(res, FLOW_COOKIE, '/auth/google');
    setCookie(res, SESSION_COOKIE, signSession(d.cookieSecret, { email, exp: d.clock.now() + SESSION_TTL_MS }), SESSION_TTL_MS);
    d.log({ level: 'info', msg: 'admin signed in' });
    res.redirect(303, '/admin');
  });

  r.get('/auth/logout', (_req, res) => {
    clearCookie(res, SESSION_COOKIE);
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(adminLayout({ title: 'Signed out', body: `<h1>Signed out</h1><p><a href="/admin/login">Sign in</a></p>` }));
  });

  return r;
}
