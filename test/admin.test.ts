import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import type { GoogleSignIn } from '../src/admin/auth';
import { csrfToken, SESSION_COOKIE, signSession, verifySession } from '../src/admin/session';
import { FakeClock } from '../src/clock';
import { memoryDatabases } from '../src/db';

const SECRET = 'x'.repeat(40);
const ADMIN = 'admin@example.com';
const PUBLIC = 'https://shop.example.com';

function setup(google?: GoogleSignIn) {
  const clock = new FakeClock(Date.UTC(2026, 10, 26, 12));
  const { catalog, orders } = memoryDatabases();
  const logs: Record<string, unknown>[] = [];
  const app = createApp({
    auth: { google, cookieSecret: SECRET, allowedEmails: [ADMIN], clock, log: (l) => logs.push(l) },
    admin: { catalog, orders, clock, mode: 'test', cookieSecret: SECRET, allowedEmails: [ADMIN], publicUrl: PUBLIC },
  });
  const session = { email: ADMIN, exp: clock.now() + 3600_000 };
  // The e2e approach (review 2 F8): mint a real signed cookie; no test login route exists.
  const cookie = `${SESSION_COOKIE}=${signSession(SECRET, session)}`;
  const csrf = csrfToken(SECRET, session);
  const work = (id: string, allowed: number) =>
    catalog
      .prepare(
        `INSERT INTO works (source_id, work_id, title, kind, canonical_url, original_url, source_version, prints_allowed, seen_at)
         VALUES ('art', ?, ?, 'painting', 'https://a/?id=x', 'https://a/x.jpg', 'v1', ?, 'now')`,
      )
      .run(id, `Work ${id}`, allowed);
  return { app, clock, catalog, orders, cookie, csrf, work, logs };
}

describe('sessions', () => {
  it('signs and verifies; rejects tampering and expiry', () => {
    const clock = new FakeClock();
    const v = signSession(SECRET, { email: ADMIN, exp: clock.now() + 1000 });
    expect(verifySession(SECRET, v, clock)).toMatchObject({ email: ADMIN });
    expect(verifySession('y'.repeat(40), v, clock)).toBeUndefined();
    const [payload, sig] = v.split('.');
    const forged = Buffer.from(JSON.stringify({ email: 'evil@example.com', exp: clock.now() + 1000 })).toString('base64url');
    expect(verifySession(SECRET, `${forged}.${sig}`, clock)).toBeUndefined();
    expect(verifySession(SECRET, `${payload}`, clock)).toBeUndefined();
    clock.advance(1000);
    expect(verifySession(SECRET, v, clock)).toBeUndefined();
  });
});

describe('sign-in pages (vault: logout really logs out)', () => {
  it('/admin without a session goes to a 200 login page, never to Google', async () => {
    const { app } = setup();
    const res = await request(app).get('/admin/works');
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/admin/login');
    const login = await request(app).get('/admin/login');
    expect(login.status).toBe(200);
    expect(login.text).toContain('Sign-in is not configured');
  });

  it('logout clears the cookie with the same attributes and lands on a page with a Sign in link', async () => {
    const { app, cookie } = setup();
    const res = await request(app).get('/auth/logout').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.text).toContain('href="/admin/login">Sign in');
    expect(res.headers['set-cookie'][0]).toMatch(/^shop_admin=; Path=\/; Expires=Thu, 01 Jan 1970.*HttpOnly; Secure; SameSite=Lax/);
  });
});

describe('Google callback', () => {
  const fake = (claims: { email?: string; email_verified?: boolean; nonce?: string } | 'fail'): GoogleSignIn => ({
    authUrl: (state, nonce, challenge) => `https://accounts.google.com/auth?state=${state}&nonce=${nonce}&cc=${challenge}`,
    codeVerifier: async () => ({ codeVerifier: 'verifier', codeChallenge: 'challenge' }),
    exchange: async (_code, verifier) => {
      if (claims === 'fail' || verifier !== 'verifier') throw new Error('bad');
      return claims;
    },
  });

  async function start(google: GoogleSignIn, app: ReturnType<typeof setup>['app']) {
    const res = await request(app).get('/auth/google/login');
    expect(res.status).toBe(302);
    const url = new URL(res.headers.location);
    const flowCookie = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('shop_oauth='))!;
    expect(flowCookie).toMatch(/Path=\/auth\/google; .*HttpOnly; Secure; SameSite=Lax/);
    return { state: url.searchParams.get('state')!, nonce: url.searchParams.get('nonce')!, cookie: flowCookie.split(';')[0] };
  }

  it('signs in an allowed, verified account whose nonce matches', async () => {
    let nonce = '';
    const google = fake({ email: 'Admin@Example.com', email_verified: true, get nonce() { return nonce; } });
    const { app } = setup(google);
    const flow = await start(google, app);
    nonce = flow.nonce;
    const res = await request(app).get(`/auth/google/callback?code=c&state=${flow.state}`).set('Cookie', flow.cookie);
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/admin');
    const session = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('shop_admin='))!;
    expect(session).toMatch(/Max-Age=43200; Path=\/; .*HttpOnly; Secure; SameSite=Lax/);
  });

  it('refuses a wrong state, a wrong nonce, an unverified or unlisted account, and a failed exchange', async () => {
    type Claims = { email?: string; email_verified?: boolean; nonce?: string };
    const cases: Array<[Claims | 'fail', RegExp]> = [
      [{ email: ADMIN, email_verified: true, nonce: 'other' }, /does not match/],
      [{ email: ADMIN, email_verified: false, nonce: '' }, /not allowed/],
      [{ email: 'someone@example.com', email_verified: true, nonce: '' }, /not allowed/],
      ['fail', /could not confirm/],
    ];
    for (const [claims, why] of cases) {
      const google = fake(claims);
      const { app } = setup(google);
      const flow = await start(google, app);
      // An empty nonce stands for "the right one": only the other check fails.
      if (typeof claims === 'object' && claims.nonce === '') claims.nonce = flow.nonce;
      const res = await request(app).get(`/auth/google/callback?code=c&state=${flow.state}`).set('Cookie', flow.cookie);
      expect(res.status).toBe(403);
      expect(res.text).toMatch(why);
      expect(([] as string[]).concat(res.headers['set-cookie'] ?? []).join()).not.toMatch(/shop_admin=[^;]/);
    }
    const google = fake({ email: ADMIN, email_verified: true });
    const { app } = setup(google);
    const flow = await start(google, app);
    expect((await request(app).get(`/auth/google/callback?code=c&state=wrong`).set('Cookie', flow.cookie)).status).toBe(403);
    expect((await request(app).get(`/auth/google/callback?code=c&state=${flow.state}`)).status).toBe(403);
  });
});

describe('admin requests', () => {
  it('admits a valid session, no-store; refuses one whose e-mail is no longer allowed', async () => {
    const { app, cookie, clock, catalog, orders } = setup();
    const res = await request(app).get('/admin').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).toContain('TEST');
    const other = createApp({ admin: { catalog, orders, clock, mode: 'test', cookieSecret: SECRET, allowedEmails: ['new@example.com'], publicUrl: PUBLIC } });
    expect((await request(other).get('/admin').set('Cookie', cookie)).status).toBe(303);
  });

  it('changes need the CSRF token and the same origin', async () => {
    const { app, cookie, csrf, work } = setup();
    work('w1', 1);
    const post = () => request(app).post('/admin/works/art/w1/enable').set('Cookie', cookie).type('form');
    expect((await post().send({})).status).toBe(403);
    expect((await post().send({ _csrf: 'wrong' })).status).toBe(403);
    expect((await post().set('Origin', 'https://evil.example.net').send({ _csrf: csrf })).status).toBe(403);
    expect((await post().set('Sec-Fetch-Site', 'cross-site').send({ _csrf: csrf })).status).toBe(403);
    expect((await request(app).post('/admin/works/art/w1/enable').type('form').send({ _csrf: csrf })).status).toBe(403);
    expect((await post().set('Origin', PUBLIC).send({ _csrf: csrf })).status).toBe(303);
  });
});

describe('works', () => {
  it('lists works; enables only where the source allows prints; records the change and queues the original', async () => {
    const { app, cookie, csrf, work, catalog, orders } = setup();
    work('w1', 1);
    work('w2', 0);
    const list = await request(app).get('/admin/works').set('Cookie', cookie);
    expect(list.text).toContain('Work w1');
    expect(list.text).toContain('Prints not allowed by the source');
    expect(list.text).toContain('action="/admin/works/art/w1/enable"');

    const refused = await request(app).post('/admin/works/art/w2/enable').set('Cookie', cookie).type('form').send({ _csrf: csrf });
    expect(refused.status).toBe(409);
    expect((await request(app).post('/admin/works/art/nope/enable').set('Cookie', cookie).type('form').send({ _csrf: csrf })).status).toBe(404);

    const ok = await request(app).post('/admin/works/art/w1/enable').set('Cookie', cookie).type('form').send({ _csrf: csrf });
    expect(ok.status).toBe(303);
    expect((catalog.prepare("SELECT enabled FROM works WHERE work_id = 'w1'").get() as { enabled: number }).enabled).toBe(1);
    expect(orders.prepare('SELECT kind, key FROM jobs').all()).toEqual([{ kind: 'work.original', key: 'art/w1' }]);
    expect(orders.prepare('SELECT actor, action, target FROM admin_audit').all()).toEqual([{ actor: ADMIN, action: 'work.enable', target: 'art/w1' }]);

    await request(app).post('/admin/works/art/w1/disable').set('Cookie', cookie).type('form').send({ _csrf: csrf });
    expect((catalog.prepare("SELECT enabled FROM works WHERE work_id = 'w1'").get() as { enabled: number }).enabled).toBe(0);
  });
});
