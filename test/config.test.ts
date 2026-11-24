import { describe, expect, it } from 'vitest';
import { ConfigError, describeConfig, loadConfig } from '../src/config';

const secret = (c: string) => c.repeat(40);

/** A complete test-mode environment with obviously fake values. */
function testEnv(over: Record<string, string | undefined> = {}) {
  return {
    SHOP_MODE: 'test',
    PUBLIC_URL: 'https://shop.example.com',
    PREVIEW_KEY: 'preview-fake',
    PRINTFUL_TOKEN: 'fake-printful-token',
    PRINTFUL_STORE_TEST: 'store-a',
    STRIPE_SECRET_KEY: 'rk_test_fake',
    GOOGLE_CLIENT_ID: 'id',
    GOOGLE_CLIENT_SECRET: 'secret',
    GOOGLE_REDIRECT_URI: 'https://shop.example.com/auth/google/callback',
    ALLOWED_EMAILS: ' Admin@Example.com ',
    COOKIE_SECRET: secret('c'),
    STATUS_TOKEN_SECRET: secret('s'),
    APPROVAL_OVER_CENTS: '1',
    REPEAT_OVER_CENTS: '2',
    REPEAT_ORDERS: '3',
    BREAKER_ORDERS_24H: '4',
    BREAKER_COST_CENTS_24H: '5',
    MAX_ITEMS_PER_ORDER: '6',
    MAX_ORDER_CENTS: '7',
    SKU_MAX_QUANTITY: '{"default":2,"postcard-4x6":3}',
    ...over,
  };
}

function problems(env: Record<string, string | undefined>): string[] {
  try {
    loadConfig(env);
    return [];
  } catch (e) {
    if (e instanceof ConfigError) return e.problems;
    throw e;
  }
}

describe('mode', () => {
  it('defaults to mock with artificial limits and the gate on', () => {
    const c = loadConfig({});
    expect(c.mode).toBe('mock');
    expect(c.previewGate).toBe(true);
    expect(c.limits.maxQuantity.default).toBeGreaterThan(0);
    expect(c.publicUrl).toBe('http://localhost:8080');
  });

  it('refuses an unknown mode', () => {
    expect(problems({ SHOP_MODE: 'production' })).toEqual(['SHOP_MODE must be mock, test or live']);
  });

  it('accepts a complete test environment', () => {
    const c = loadConfig(testEnv());
    expect(c.mode).toBe('test');
    expect(c.printful.expectedStore).toBe('store-a');
    expect(c.admin.allowedEmails).toEqual(['admin@example.com']);
    expect(c.limits.maxQuantity).toEqual({ default: 2, 'postcard-4x6': 3 });
  });
});

describe('keys must agree with the mode (ADR-0029)', () => {
  it('refuses a real Stripe key in mock mode', () => {
    expect(problems({ STRIPE_SECRET_KEY: 'rk_test_x' }).join()).toMatch(/real Stripe key/);
  });

  it('refuses the real hosts in mock mode', () => {
    expect(problems({ PRINTFUL_BASE_URL: 'https://api.printful.com/v2' }).join()).toMatch(/PRINTFUL_BASE_URL points at the real service/);
    expect(problems({ STRIPE_API_BASE: 'https://api.stripe.com' }).join()).toMatch(/STRIPE_API_BASE points at the real service/);
  });

  it('refuses a live key in test mode and a test key in live mode', () => {
    expect(problems(testEnv({ STRIPE_SECRET_KEY: 'rk_live_x' })).join()).toMatch(/restricted test key/);
    const live = testEnv({ SHOP_MODE: 'live', PRINTFUL_STORE_LIVE: 'store-b' });
    expect(problems(live).join()).toMatch(/restricted live key/);
  });

  it('refuses mock hosts and mock tokens with real keys', () => {
    expect(problems(testEnv({ PRINTFUL_BASE_URL: 'http://mocks:9000' })).join()).toMatch(/PRINTFUL_BASE_URL is for mock mode only/);
    expect(problems(testEnv({ PRINTFUL_TOKEN: 'mock_printful_x' })).join()).toMatch(/mock token/);
  });

  it('takes the mock source address and the mock checkout pages in mock mode only, local only', () => {
    const c = loadConfig({ MOCK_SOURCE_URL: 'http://localhost:9103/', STRIPE_API_BASE: 'http://localhost:9102' });
    expect(c.mockSourceUrl).toBe('http://localhost:9103');
    expect(c.mockStripePages).toBe('http://localhost:9102');
    expect(loadConfig({}).mockStripePages).toBeUndefined();
    expect(problems({ MOCK_SOURCE_URL: 'https://art.klaushofrichter.net' }).join()).toMatch(/MOCK_SOURCE_URL must be a local http address/);
    expect(problems(testEnv({ MOCK_SOURCE_URL: 'http://localhost:9103' })).join()).toMatch(/MOCK_SOURCE_URL is for mock mode only/);
  });

  it('needs the expected store per mode, and live must differ from test', () => {
    expect(problems(testEnv({ PRINTFUL_STORE_TEST: undefined })).join()).toMatch(/PRINTFUL_STORE_TEST is required/);
    const live = testEnv({ SHOP_MODE: 'live', STRIPE_SECRET_KEY: 'rk_live_x', PRINTFUL_STORE_LIVE: 'store-a' });
    expect(problems(live)).toContain('PRINTFUL_STORE_LIVE equals PRINTFUL_STORE_TEST');
  });
});

describe('the preview gate (ADR-0039)', () => {
  it('can be off only in live mode', () => {
    expect(problems(testEnv({ PREVIEW_GATE: 'off' })).join()).toMatch(/only in live mode/);
    const live = testEnv({ SHOP_MODE: 'live', STRIPE_SECRET_KEY: 'rk_live_x', PRINTFUL_STORE_LIVE: 'store-b', PREVIEW_GATE: 'off', PREVIEW_KEY: undefined });
    expect(loadConfig(live).previewGate).toBe(false);
  });

  it('starts live with the gate on, which needs a key', () => {
    const live = testEnv({ SHOP_MODE: 'live', STRIPE_SECRET_KEY: 'rk_live_x', PRINTFUL_STORE_LIVE: 'store-b', PREVIEW_KEY: undefined });
    expect(problems(live).join()).toMatch(/PREVIEW_KEY is required/);
  });
});

describe('deployed modes need their settings', () => {
  it('lists every missing threshold, never a value', () => {
    const p = problems(testEnv({ APPROVAL_OVER_CENTS: undefined, SKU_MAX_QUANTITY: '{"x":1}' }));
    expect(p).toContain('APPROVAL_OVER_CENTS is required in test mode (value in kube-setup)');
    expect(p.join()).toMatch(/SKU_MAX_QUANTITY must be a JSON object/);
  });

  it('needs https, the admin settings and long secrets', () => {
    const p = problems(testEnv({ PUBLIC_URL: 'http://shop.example.com', ALLOWED_EMAILS: '', COOKIE_SECRET: 'short' }));
    expect(p).toEqual(expect.arrayContaining(['PUBLIC_URL must be https in test mode', 'ALLOWED_EMAILS is required in test mode', 'COOKIE_SECRET must be at least 32 characters']));
  });

  it('never puts a secret value in an error or the description', () => {
    const env = testEnv({ COOKIE_SECRET: 'tooshort-but-secret', STRIPE_SECRET_KEY: 'rk_live_supersecret' });
    const text = problems(env).join('\n');
    expect(text).not.toMatch(/tooshort-but-secret|supersecret/);
    const described = describeConfig(loadConfig(testEnv()));
    expect(described).not.toMatch(/rk_test_fake|fake-printful-token|preview-fake/);
  });
});
