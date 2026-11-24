import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { esc } from '../src/pages';

const app = createApp();

afterEach(() => {
  delete process.env.APP_VERSION;
});

describe('/health', () => {
  it('answers 200 with status and version', async () => {
    process.env.APP_VERSION = '2099.01.01.1';
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', version: '2099.01.01.1' });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('reports dev without a stamped version', async () => {
    const res = await request(app).get('/health');
    expect(res.body.version).toBe('dev');
  });

  it('answers HEAD (the uptime monitor uses it)', async () => {
    const res = await request(app).head('/health');
    expect(res.status).toBe(200);
  });
});

describe('pages', () => {
  it('serves the home page with a strict content security policy', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.type).toBe('text/html');
    expect(res.text).toContain('<html lang="en">');
    expect(res.text).toContain('https://art.klaushofrichter.net/');
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    expect(res.headers['content-security-policy']).not.toContain('unsafe-inline');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('compresses text', async () => {
    for (const path of ['/', '/static/shop.css', '/does-not-exist']) {
      const res = await request(app).get(path).set('Accept-Encoding', 'gzip');
      expect(res.headers['content-encoding'], path).toBe('gzip');
    }
  });

  it('answers unknown paths with a 404 page', async () => {
    const res = await request(app).get('/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.text).toContain('Not found');
  });
});

describe('esc', () => {
  it('escapes HTML metacharacters', () => {
    expect(esc(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });
});
