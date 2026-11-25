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
  /** Mock mode only: read every content source from here (the fake art in the e2e run). */
  mockSourceUrl?: string;
  /** Mock mode only: the shop passes /__mock-pages/stripe/* through to mock Stripe, so its page is same-origin (14 §9). */
  mockStripePages?: string;
  /** sharp's limitInputPixels and the upload limit (docs/design/04 §5.5). */
  maxInputPixels: number;
  printful: {
    token?: string;
    baseUrl: string;
    expectedStore?: string;
    webhookSecret?: string;
    webhookPublicKey?: string;
    /** The request trace for the go-live recording runs until then (14 §7.3); start-up caps it at 7 days. */
    traceUntilMs?: number;
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
  /** The pre-payment cost check and shipping (docs/design/05 §2). Not secret; defaults below. */
  quote: QuoteSettings;
  /** E-mail via SES (09, ADR-0015, ADR-0038). Addresses come from the ConfigMap, never this repository. */
  email: {
    enabled: boolean;
    from: string;
    /** Klaus's address for alerts. */
    alertTo?: string;
    /** SES forwards bounces and complaints here (the Return-Path); never From or Reply-To. */
    feedbackTo?: string;
    /** Mock and test mode: customer e-mails only to these (09 §1). */
    allowlist: string[];
    delayNoticeMs: number;
    alertNewOrders: boolean;
    ses?: { region: string; accessKeyId: string; secretAccessKey: string; endpoint?: string };
  };
  /** Submission (06 §3–4). The packing-slip contact is Klaus's and lives in the cluster's ConfigMap, not here. */
  fulfilment: {
    providerRetryWindowMs: number;
    /** Completion rule 2 (07 §2.7): everything shipped this many days ago. */
    completeAfterShippedDays: number;
    shopName: string;
    packingSlipEmail?: string;
    packingSlipPhone?: string;
  };
}

export interface QuoteSettings {
  marginFloorCents: number;
  shippingMarkupCents: number;
  /** Sales tax Printful charges on wholesale until the resale certificate is on file, in percent. */
  providerTaxAllowancePct: number;
  /** Stripe's card fee plus Stripe Tax, in percent, and the fixed part in cents. */
  stripeFeePct: number;
  stripeFeeFixedCents: number;
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
    const ms = get('MOCK_SOURCE_URL');
    if (ms && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(ms)) problems.push('MOCK_SOURCE_URL must be a local http address');
    for (const [name, value, realHost] of [
      ['PRINTFUL_BASE_URL', printfulBase, REAL_PRINTFUL],
      ['STRIPE_API_BASE', stripeBase, REAL_STRIPE],
    ] as const) {
      if (value && sameHost(value, realHost)) problems.push(`${name} points at the real service; mock mode needs the mock`);
    }
  } else {
    if (get('MOCK_SOURCE_URL')) problems.push(`MOCK_SOURCE_URL is for mock mode only`);
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

  const num = (name: string, dflt: number, max: number, integer = true): number => {
    const raw = get(name);
    if (raw === undefined) return dflt;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > max || (integer && !Number.isInteger(n))) {
      problems.push(`${name} must be a number between 0 and ${max}`);
      return dflt;
    }
    return n;
  };
  const quote: QuoteSettings = {
    marginFloorCents: num('MARGIN_FLOOR_CENTS', 0, 100_000),
    shippingMarkupCents: num('SHIPPING_MARKUP_CENTS', 0, 10_000),
    providerTaxAllowancePct: num('PROVIDER_TAX_ALLOWANCE_PCT', 8.25, 20, false),
    stripeFeePct: num('STRIPE_FEE_PCT', 3.4, 10, false),
    stripeFeeFixedCents: num('STRIPE_FEE_FIXED_CENTS', 30, 200),
  };

  const onOff = (name: string, dflt: boolean): boolean => {
    const v = get(name);
    if (v === undefined) return dflt;
    if (v !== 'on' && v !== 'off') problems.push(`${name} must be on or off`);
    return v === 'on';
  };
  const isEmail = (v: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v);
  const sesKey = get('SHOP_SES_AWS_ACCESS_KEY_ID');
  const sesSecret = get('SHOP_SES_AWS_SECRET_ACCESS_KEY');
  const sesEndpoint = get('SES_ENDPOINT');
  if (!!sesKey !== !!sesSecret) problems.push('SHOP_SES_AWS_ACCESS_KEY_ID and SHOP_SES_AWS_SECRET_ACCESS_KEY go together');
  if (mode === 'mock') {
    if (sesKey && !sesKey.startsWith('mock_ses_')) problems.push('SHOP_SES_AWS_ACCESS_KEY_ID must start with mock_ses_ in mock mode');
    if (sesKey && !sesEndpoint) problems.push('SES_ENDPOINT (the mock) is required with SES keys in mock mode');
    if (sesEndpoint && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(sesEndpoint)) problems.push('SES_ENDPOINT must be a local http address');
  } else {
    if (sesEndpoint) problems.push('SES_ENDPOINT is for mock mode only');
    if (sesKey?.startsWith('mock_')) problems.push(`SHOP_SES_AWS_ACCESS_KEY_ID is a mock key ${inMode}`);
  }
  const emailEnabled = onOff('EMAIL_ENABLED', false);
  if (emailEnabled && !sesKey) problems.push('EMAIL_ENABLED=on needs the SES keys');
  const publicHost = new URL(publicUrl).hostname;
  const emailFrom = get('EMAIL_FROM') ?? `orders@${publicHost.includes('.') ? publicHost : 'example.com'}`;
  if (!isEmail(emailFrom)) problems.push('EMAIL_FROM must be an e-mail address');
  const alertTo = get('ALERT_EMAIL');
  if (alertTo && !isEmail(alertTo)) problems.push('ALERT_EMAIL must be an e-mail address');
  const feedbackTo = get('SES_FEEDBACK_ADDRESS');
  if (feedbackTo && !isEmail(feedbackTo)) problems.push('SES_FEEDBACK_ADDRESS must be an e-mail address');
  const allowlist = (get('EMAIL_ALLOWLIST') ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (allowlist.some((x) => !isEmail(x))) problems.push('EMAIL_ALLOWLIST must be e-mail addresses separated by commas');
  const email = {
    enabled: emailEnabled,
    from: emailFrom,
    alertTo,
    feedbackTo,
    allowlist,
    delayNoticeMs: num('DELAY_NOTICE_HOURS', 48, 720) * 60 * 60_000,
    alertNewOrders: onOff('ALERT_NEW_ORDERS', true),
    ses: sesKey && sesSecret ? { region: get('SES_REGION') ?? 'us-east-1', accessKeyId: sesKey, secretAccessKey: sesSecret, endpoint: mode === 'mock' ? sesEndpoint : undefined } : undefined,
  };

  const traceRaw = get('PRINTFUL_TRACE_UNTIL');
  const traceUntilMs = traceRaw ? Date.parse(traceRaw) : undefined;
  if (traceRaw && !Number.isFinite(traceUntilMs!)) problems.push('PRINTFUL_TRACE_UNTIL must be a date');
  const pfSecret = get('PRINTFUL_WEBHOOK_SECRET');
  if (pfSecret && !/^([0-9a-f]{2})+$/i.test(pfSecret)) problems.push('PRINTFUL_WEBHOOK_SECRET must be hex (the secret_key Printful returns)');
  const slipEmail = get('PACKING_SLIP_EMAIL');
  if (slipEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(slipEmail)) problems.push('PACKING_SLIP_EMAIL must be an e-mail address');
  const slipPhone = get('PACKING_SLIP_PHONE');
  if (slipPhone && !/^\+?[0-9 ()-]{7,20}$/.test(slipPhone)) problems.push('PACKING_SLIP_PHONE must be a phone number');
  const fulfilment = {
    providerRetryWindowMs: num('PROVIDER_RETRY_WINDOW_HOURS', 24, 168) * 60 * 60_000,
    completeAfterShippedDays: num('COMPLETE_AFTER_SHIPPED_DAYS', 45, 365),
    shopName: get('SHOP_NAME') ?? new URL(publicUrl).host,
    packingSlipEmail: slipEmail,
    packingSlipPhone: slipPhone,
  };

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
    mockSourceUrl: mode === 'mock' ? get('MOCK_SOURCE_URL')?.replace(/\/+$/, '') : undefined,
    mockStripePages: mode === 'mock' && stripeBase ? stripeBase.replace(/\/+$/, '') : undefined,
    maxInputPixels: Math.round(mp * 1_000_000),
    printful: {
      token: printfulToken,
      baseUrl: printfulBase ?? REAL_PRINTFUL,
      expectedStore,
      webhookSecret: get('PRINTFUL_WEBHOOK_SECRET'),
      webhookPublicKey: get('PRINTFUL_WEBHOOK_PUBLIC_KEY'),
      traceUntilMs,
    },
    stripe: {
      secretKey: stripeKey,
      apiBase: stripeBase ?? REAL_STRIPE,
      webhookSecret: get('STRIPE_WEBHOOK_SECRET'),
    },
    admin,
    statusTokenSecret,
    limits,
    quote,
    fulfilment,
    email,
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
    `email=${c.email.enabled ? 'on' : 'off'}`,
    `ses=${has(c.email.ses?.accessKeyId)}`,
  ].join(' ');
}
