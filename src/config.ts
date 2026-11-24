/**
 * Configuration from the environment, validated once at startup
 * (docs/design/11 §2). `SHOP_MODE` decides what must agree (ADR-0029):
 * which keys are acceptable, which hosts, which database file.
 *
 * Errors name the variable and the rule, never the value: these messages are
 * logged, and some variables are secrets.
 */

export type Mode = 'mock' | 'test' | 'live';

export interface FailSafeLimits {
  approvalOverCents: number;
  repeatOverCents: number;
  repeatOrders: number;
  breakerOrders24h: number;
  breakerCostCents24h: number;
  maxItemsPerOrder: number;
  maxOrderCents: number;
  /** Per-SKU quantity limits; `default` applies to SKUs not listed. */
  maxQuantity: Record<string, number> & { default: number };
}

export interface Config {
  mode: Mode;
  port: number;
  publicUrl: string;
  dataDir: string;
  sourcesConfig: string;
  skusConfig: string;
  previewGate: boolean;
  previewKey?: string;
  /** Refresh content sources on a schedule (on by default on the cluster, off in mock mode). */
  sourcesRefresh: boolean;
  /** sharp's limitInputPixels and the upload limit (docs/design/04 §5.5). */
  maxInputPixels: number;
  printful: {
    token?: string;
    baseUrl: string;
    expectedStore?: string;
    webhookSecret?: string;
    webhookPublicKey?: string;
  };
  stripe: {
    secretKey?: string;
    apiBase: string;
    webhookSecret?: string;
  };
  admin: {
    googleClientId?: string;
    googleClientSecret?: string;
    googleRedirectUri?: string;
    allowedEmails: string[];
    cookieSecret?: string;
  };
  statusTokenSecret?: string;
  limits: FailSafeLimits;
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`configuration refused:\n- ${problems.join('\n- ')}`);
    this.name = 'ConfigError';
  }
}

const REAL_PRINTFUL = 'https://api.printful.com';
const REAL_STRIPE = 'https://api.stripe.com';

/**
 * Artificial limits for mock mode and tests only. Real values are deployment
 * configuration in kube-setup (ADR-0020, ADR-0028) and are required in test
 * and live mode.
 */
const MOCK_LIMITS: FailSafeLimits = {
  approvalOverCents: 77_700,
  repeatOverCents: 66_600,
  repeatOrders: 7,
  breakerOrders24h: 17,
  breakerCostCents24h: 99_900,
  maxItemsPerOrder: 13,
  maxOrderCents: 111_100,
  maxQuantity: { default: 9 },
};

const LIMIT_VARS: Array<[keyof Omit<FailSafeLimits, 'maxQuantity'>, string]> = [
  ['approvalOverCents', 'APPROVAL_OVER_CENTS'],
  ['repeatOverCents', 'REPEAT_OVER_CENTS'],
  ['repeatOrders', 'REPEAT_ORDERS'],
  ['breakerOrders24h', 'BREAKER_ORDERS_24H'],
  ['breakerCostCents24h', 'BREAKER_COST_CENTS_24H'],
  ['maxItemsPerOrder', 'MAX_ITEMS_PER_ORDER'],
  ['maxOrderCents', 'MAX_ORDER_CENTS'],
];

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env): Config {
  const problems: string[] = [];
  const get = (name: string): string | undefined => {
    const v = env[name]?.trim();
    return v ? v : undefined;
  };
  const need = (name: string, why: string): string | undefined => {
    const v = get(name);
    if (!v) problems.push(`${name} is required ${why}`);
    return v;
  };

  const modeRaw = get('SHOP_MODE') ?? 'mock';
  if (modeRaw !== 'mock' && modeRaw !== 'test' && modeRaw !== 'live') {
    throw new ConfigError(['SHOP_MODE must be mock, test or live']);
  }
  const mode: Mode = modeRaw;
  const real = mode !== 'mock';
  const inMode = `in ${mode} mode`;

  const port = Number(get('PORT') ?? 8080);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) problems.push('PORT must be a port number');

  const publicUrl = (real ? need('PUBLIC_URL', inMode) : get('PUBLIC_URL')) ?? `http://localhost:${port}`;
  if (real && get('PUBLIC_URL') && !publicUrl.startsWith('https://')) problems.push(`PUBLIC_URL must be https ${inMode}`);

  // The preview gate (ADR-0039): always on before go-live; live mode chooses.
  const gateRaw = get('PREVIEW_GATE') ?? 'on';
  if (gateRaw !== 'on' && gateRaw !== 'off') problems.push('PREVIEW_GATE must be on or off');
  const previewGate = gateRaw !== 'off';
  if (!previewGate && mode !== 'live') problems.push(`PREVIEW_GATE can be off only in live mode`);
  const previewKey = get('PREVIEW_KEY');
  if (previewGate && real && !previewKey) problems.push(`PREVIEW_KEY is required while the preview gate is on ${inMode}`);

  // Printful and Stripe: keys and hosts must agree with the mode.
  const printfulToken = get('PRINTFUL_TOKEN');
  const stripeKey = get('STRIPE_SECRET_KEY');
  const printfulBase = get('PRINTFUL_BASE_URL');
  const stripeBase = get('STRIPE_API_BASE');
  const looksRealStripe = (k: string) => /^(sk|rk|pk)_(test|live)_/.test(k);

  if (mode === 'mock') {
    if (stripeKey && looksRealStripe(stripeKey)) problems.push('STRIPE_SECRET_KEY is a real Stripe key; mock mode takes mock keys only');
    if (stripeKey && !stripeKey.startsWith('mock_stripe_')) problems.push('STRIPE_SECRET_KEY must start with mock_stripe_ in mock mode');
    if (printfulToken && !printfulToken.startsWith('mock_printful_')) problems.push('PRINTFUL_TOKEN must start with mock_printful_ in mock mode');
    for (const [name, value, realHost] of [
      ['PRINTFUL_BASE_URL', printfulBase, REAL_PRINTFUL],
      ['STRIPE_API_BASE', stripeBase, REAL_STRIPE],
    ] as const) {
      if (value && sameHost(value, realHost)) problems.push(`${name} points at the real service; mock mode needs the mock`);
    }
  } else {
    if (printfulBase) problems.push(`PRINTFUL_BASE_URL is for mock mode only`);
    if (stripeBase) problems.push(`STRIPE_API_BASE is for mock mode only`);
    need('PRINTFUL_TOKEN', inMode);
    if (stripeKey === undefined) problems.push(`STRIPE_SECRET_KEY is required ${inMode}`);
    const prefix = mode === 'live' ? 'rk_live_' : 'rk_test_';
    if (stripeKey && !stripeKey.startsWith(prefix)) problems.push(`STRIPE_SECRET_KEY must be a restricted ${mode} key (${prefix}) ${inMode}`);
    if (printfulToken?.startsWith('mock_')) problems.push(`PRINTFUL_TOKEN is a mock token ${inMode}`);
  }

  // The expected Printful store comes from its own variable (review A F9).
  const storeTest = get('PRINTFUL_STORE_TEST');
  const storeLive = get('PRINTFUL_STORE_LIVE');
  let expectedStore: string | undefined;
  if (mode === 'test') expectedStore = need('PRINTFUL_STORE_TEST', inMode);
  if (mode === 'live') {
    expectedStore = need('PRINTFUL_STORE_LIVE', inMode);
    if (storeLive && storeTest && storeLive === storeTest) problems.push('PRINTFUL_STORE_LIVE equals PRINTFUL_STORE_TEST');
  }

  // Admin sign-in and status links: needed wherever the shop is deployed.
  const admin = {
    googleClientId: real ? need('GOOGLE_CLIENT_ID', inMode) : get('GOOGLE_CLIENT_ID'),
    googleClientSecret: real ? need('GOOGLE_CLIENT_SECRET', inMode) : get('GOOGLE_CLIENT_SECRET'),
    googleRedirectUri: real ? need('GOOGLE_REDIRECT_URI', inMode) : get('GOOGLE_REDIRECT_URI'),
    allowedEmails: (get('ALLOWED_EMAILS') ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
    cookieSecret: real ? need('COOKIE_SECRET', inMode) : get('COOKIE_SECRET'),
  };
  if (real && admin.allowedEmails.length === 0) problems.push(`ALLOWED_EMAILS is required ${inMode}`);
  for (const [name, value] of [
    ['COOKIE_SECRET', admin.cookieSecret],
    ['STATUS_TOKEN_SECRET', get('STATUS_TOKEN_SECRET')],
  ] as const) {
    if (value && value.length < 32) problems.push(`${name} must be at least 32 characters`);
  }
  const statusTokenSecret = real ? need('STATUS_TOKEN_SECRET', inMode) : get('STATUS_TOKEN_SECRET');

  const refreshRaw = get('SOURCES_REFRESH') ?? (real ? 'on' : 'off');
  if (refreshRaw !== 'on' && refreshRaw !== 'off') problems.push('SOURCES_REFRESH must be on or off');
  const mp = Number(get('MAX_INPUT_MEGAPIXELS') ?? 50);
  if (!Number.isFinite(mp) || mp < 1 || mp > 200) problems.push('MAX_INPUT_MEGAPIXELS must be between 1 and 200');

  const limits = loadLimits(env, mode, problems);

  if (problems.length) throw new ConfigError(problems);

  return {
    mode,
    port,
    publicUrl: publicUrl.replace(/\/+$/, ''),
    dataDir: get('DATA_DIR') ?? './data',
    sourcesConfig: get('SOURCES_CONFIG') ?? './config/sources.json',
    skusConfig: get('SKUS_CONFIG') ?? './config/skus.json',
    previewGate,
    previewKey,
    sourcesRefresh: refreshRaw === 'on',
    maxInputPixels: Math.round(mp * 1_000_000),
    printful: {
      token: printfulToken,
      baseUrl: printfulBase ?? REAL_PRINTFUL,
      expectedStore,
      webhookSecret: get('PRINTFUL_WEBHOOK_SECRET'),
      webhookPublicKey: get('PRINTFUL_WEBHOOK_PUBLIC_KEY'),
    },
    stripe: {
      secretKey: stripeKey,
      apiBase: stripeBase ?? REAL_STRIPE,
      webhookSecret: get('STRIPE_WEBHOOK_SECRET'),
    },
    admin,
    statusTokenSecret,
    limits,
  };
}

function loadLimits(env: Env, mode: Mode, problems: string[]): FailSafeLimits {
  const present = LIMIT_VARS.some(([, name]) => env[name]?.trim()) || env.SKU_MAX_QUANTITY?.trim();
  if (mode === 'mock' && !present) return MOCK_LIMITS;

  const limits = { ...MOCK_LIMITS, maxQuantity: { ...MOCK_LIMITS.maxQuantity } };
  for (const [key, name] of LIMIT_VARS) {
    const raw = env[name]?.trim();
    if (!raw) {
      problems.push(`${name} is required in ${mode} mode (value in kube-setup)`);
      continue;
    }
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) problems.push(`${name} must be a positive integer`);
    else limits[key] = n;
  }
  const rawQ = env.SKU_MAX_QUANTITY?.trim();
  if (!rawQ) {
    problems.push(`SKU_MAX_QUANTITY is required in ${mode} mode (value in kube-setup)`);
  } else {
    try {
      const parsed: unknown = JSON.parse(rawQ);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      const entries = Object.entries(parsed as Record<string, unknown>);
      if (!entries.every(([, v]) => Number.isInteger(v) && (v as number) > 0)) throw new Error();
      if (!('default' in (parsed as object))) throw new Error();
      limits.maxQuantity = parsed as FailSafeLimits['maxQuantity'];
    } catch {
      problems.push('SKU_MAX_QUANTITY must be a JSON object of positive integers with a "default" entry');
    }
  }
  return limits;
}

function sameHost(url: string, other: string): boolean {
  try {
    return new URL(url).host === new URL(other).host;
  } catch {
    return false;
  }
}

/** Which settings are present, for the startup log. Never values. */
export function describeConfig(c: Config): string {
  const has = (v: unknown) => (v ? 'set' : 'unset');
  return [
    `mode=${c.mode}`,
    `previewGate=${c.previewGate ? 'on' : 'off'}`,
    `printfulToken=${has(c.printful.token)}`,
    `stripeKey=${has(c.stripe.secretKey)}`,
    `stripeWebhookSecret=${has(c.stripe.webhookSecret)}`,
    `printfulWebhookSecret=${has(c.printful.webhookSecret)}`,
    `statusTokenSecret=${has(c.statusTokenSecret)}`,
  ].join(' ');
}
