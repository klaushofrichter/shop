#!/usr/bin/env node
// Capture how the real Printful and Stripe APIs behave, for the mock services
// (docs/design/14-mock-services.md §7.2). Run on the cluster node, where the keys are:
//
//   node scripts/capture/capture-apis.mjs --env <path to the shop .env on the node> --out <shop-private checkout>/captures/<date>
//
// Klaus allowed (2026-11-24): the Stripe TEST key, and careful Printful DRAFT orders,
// "but never actually order something". So, enforced below, not just by convention:
//   - Stripe: only a key starting with rk_test_ or sk_test_ is accepted.
//   - Printful: every request must match ALLOW; there is no rule for
//     /v2/orders/{id}/confirmation, and any path containing "confirm" is refused
//     outright. Drafts are created with external_id "capture-…" and deleted at the end.
//   - Printful: only the TEST store's token (PRINTFUL_TOKEN_TEST) is read; the live
//     store's token is never used (ADR-0029).
//   - Output: --out is required and must be outside this public repository's work tree
//     (raw captures belong in the private repository, ADR-0028).
//   - Requests are sequential and paced (rate limits).
// Output: one JSON file per scenario with method, path, request body, status,
// selected headers and response body. Secrets never appear: the Authorization header
// is not recorded, and the redactor replaces anything that looks like a key.
// Needs Node 26 (global fetch). No dependencies.

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

// ---------- arguments and keys ----------
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith('--')) args[a.slice(2)] = true;
  else { args[a.slice(2)] = next; i++; }
}
const envPath = resolve(String(args.env ?? '.env').replace(/^~/, homedir()));
const outDir = args.out ? resolve(String(args.out)) : null;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const insideRepo = (dir) => { const r = relative(REPO_ROOT, dir); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };
const only = args.only ? String(args.only).split(',') : ['printful', 'stripe'];
const skipDrafts = args['no-drafts'] === true;

function readEnv(path) {
  const env = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return env;
}
const env = args['self-test'] ? {} : readEnv(envPath);
const PRINTFUL_TOKEN = env.PRINTFUL_TOKEN_TEST; // the test store only; PRINTFUL_TOKEN (live) is never read
const STRIPE_KEY = env.STRIPE_TEST_TOKEN;
if (!args['self-test'] && (only.includes('printful') || only.includes('estimation') || only.includes('files')) && !PRINTFUL_TOKEN) die('PRINTFUL_TOKEN_TEST missing (the live store token is never used)');
if (!args['self-test'] && only.includes('stripe')) {
  if (!STRIPE_KEY) die('STRIPE_TEST_TOKEN missing');
  if (!/^(rk|sk)_test_/.test(STRIPE_KEY)) die('STRIPE_TEST_TOKEN is not a test-mode key; refusing');
}
const SECRETS = [PRINTFUL_TOKEN, STRIPE_KEY].filter(Boolean);

function die(msg) {
  console.error(`capture: ${msg}`);
  process.exit(1);
}

// ---------- safety: Printful allow-list ----------
const ALLOW = [
  ['GET', /^\/v2\/stores$/],
  ['GET', /^\/v2\/oauth-scopes$/],
  ['GET', /^\/v2\/webhooks$/],
  ['GET', /^\/v2\/catalog-products\/\d+(\/(catalog-variants|mockup-styles|prices|sizes|availability|shipping-countries))?$/],
  ['GET', /^\/v2\/catalog-variants\/\d+(\/(prices|availability))?$/],
  ['POST', /^\/v2\/shipping-rates$/],
  ['POST', /^\/v2\/order-estimation-tasks$/],
  ['GET', /^\/v2\/order-estimation-tasks$/],
  ['POST', /^\/v2\/mockup-tasks$/],
  ['GET', /^\/v2\/mockup-tasks$/],
  ['POST', /^\/v2\/files$/],
  ['GET', /^\/v2\/files\/\d+$/],
  ['POST', /^\/v2\/orders$/],                         // creates a DRAFT (v2 always does)
  ['GET', /^\/v2\/orders\/(\d+|@capture-[A-Za-z0-9_-]+)(\/(order-items|shipments|invoices))?$/],
  ['PATCH', /^\/v2\/orders\/\d+$/],                   // edit a draft
  ['DELETE', /^\/v2\/orders\/\d+$/],                  // delete a draft
  ['DELETE', /^\/orders\/\d+$/],                      // v1 cancel, used only on our own draft
  ['GET', /^\/orders\/@capture-[A-Za-z0-9_-]+$/],     // v1 lookup of our draft
];
const createdDrafts = new Set();                      // Printful ids we created; only these may be PATCHed or DELETEd

function assertPrintfulAllowed(method, path) {
  const p = path.split('?')[0];
  if (/confirm/i.test(p)) die(`refused (confirmation is never allowed): ${method} ${p}`);
  if (!ALLOW.some(([m, re]) => m === method && re.test(p))) die(`refused (not on the allow-list): ${method} ${p}`);
  const id = p.match(/^\/(?:v2\/)?orders\/(\d+)/)?.[1];
  if (id && (method === 'PATCH' || method === 'DELETE') && !createdDrafts.has(id)) die(`refused (not a draft we created): ${method} ${p}`);
}

// ---------- recording ----------
const KEEP_HEADERS = /^(content-type|x-ratelimit-.*|retry-after|request-id|idempotency-key|stripe-version|x-pf-.*)$/i;
function redact(value) {
  let s = JSON.stringify(value);
  for (const secret of SECRETS) s = s.split(secret).join('<redacted-key>');
  s = s.replace(/\b(sk|rk|pk)_(test|live)_[A-Za-z0-9]+/g, '<redacted-key>').replace(/whsec_[A-Za-z0-9]+/g, '<redacted-whsec>');
  return JSON.parse(s);
}
const log = [];
function save(scenario, exchanges) {
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${scenario}.json`);
  writeFileSync(file, JSON.stringify(redact({ scenario, captured_at: new Date().toISOString(), exchanges }), null, 1) + '\n');
  log.push(`${scenario}: ${exchanges.map((e) => `${e.method} ${e.path} → ${e.status}`).join('; ')}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(base, auth, method, path, { json, form, headers = {} } = {}) {
  const h = { Authorization: auth, ...headers };
  let body;
  if (json !== undefined) { h['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  if (form !== undefined) { h['Content-Type'] = 'application/x-www-form-urlencoded'; body = encodeForm(form); }
  const started = Date.now();
  const res = await fetch(base + path, { method, headers: h, body });
  const text = await res.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text.slice(0, 2000); }
  const kept = {};
  res.headers.forEach((v, k) => { if (KEEP_HEADERS.test(k)) kept[k] = v; });
  await sleep(700);
  return { method, path, request: json ?? form ?? null, request_headers: Object.fromEntries(Object.entries(headers)), status: res.status, ms: Date.now() - started, headers: kept, body: parsed };
}
function encodeForm(obj, prefix) {
  const parts = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === undefined || v === null) continue;
    if (typeof v === 'object') parts.push(encodeForm(v, key));
    else parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return parts.filter(Boolean).join('&');
}
const pf = (method, path, opts) => { assertPrintfulAllowed(method, path); return call('https://api.printful.com', `Bearer ${PRINTFUL_TOKEN}`, method, path, opts); };
const st = (method, path, opts) => call('https://api.stripe.com', `Bearer ${STRIPE_KEY}`, method, path, opts);

// ---------- fixtures shared by scenarios ----------
const SKUS = [
  { sku: 'postcard-4x6', product: 433, variant: 11513 },
  { sku: 'print-8x10', product: 1, variant: 4463 },
  { sku: 'print-16x20', product: 1, variant: 3877 },
  { sku: 'framed-8x10-black', product: 2, variant: 4651 },
  { sku: 'framed-16x20-black', product: 2, variant: 4399 },
  { sku: 'mug-11oz', product: 19, variant: 1320 },
  { sku: 'tshirt-white-m', product: 71, variant: 4012 },
];
// A public building's address (Austin Convention Center), with a placeholder person.
const ADDR = { name: 'Capture Test', address1: '500 E Cesar Chavez St', city: 'Austin', state_code: 'TX', zip: '78701', country_code: 'US' };
// A public, low-resolution image of a painting from art (fine for drafts; never printed).
const FILE_URL = 'https://art.klaushofrichter.net/assets/colors/w2560/IMG_8403.jpg';
const stamp = createHash('sha256').update(String(Date.now())).digest('hex').slice(0, 8);

// ---------- Printful ----------
async function printful() {
  save('printful-stores-scopes-webhooks', [await pf('GET', '/v2/stores'), await pf('GET', '/v2/oauth-scopes'), await pf('GET', '/v2/webhooks')]);

  for (const s of SKUS) {
    save(`printful-catalog-${s.sku}`, [
      await pf('GET', `/v2/catalog-products/${s.product}`),
      await pf('GET', `/v2/catalog-variants/${s.variant}`),
      await pf('GET', `/v2/catalog-products/${s.product}/mockup-styles`),
      await pf('GET', `/v2/catalog-variants/${s.variant}/prices?currency=USD`),
      await pf('GET', `/v2/catalog-variants/${s.variant}/availability`),
    ]);
  }
  save('printful-catalog-errors', [await pf('GET', '/v2/catalog-variants/999999999'), await pf('GET', '/v2/catalog-products/999999999')]);

  const items = (list) => list.map(([variant, quantity]) => ({ source: 'catalog', catalog_variant_id: variant, quantity }));
  const rates = async (recipient, list) => pf('POST', '/v2/shipping-rates', { json: { recipient, order_items: items(list), currency: 'USD' } });
  save('printful-shipping-rates', [
    await rates(ADDR, [[4651, 1]]),
    await rates(ADDR, [[4651, 1], [11513, 4]]),
    await rates(ADDR, [[4012, 1], [1320, 1]]),
    await rates({ ...ADDR, state_code: 'NY', city: 'New York', zip: '10001', address1: '20 W 34th St' }, [[3877, 2]]),
    await rates({ country_code: 'US', state_code: 'AK', zip: '99501' }, [[4399, 1]]),
    await rates({ country_code: 'US', state_code: 'TX', zip: '78701' }, [[11513, 25]]),
  ]);
  save('printful-shipping-rates-errors', [
    await rates({ country_code: 'US', zip: '78701' }, [[11513, 1]]),            // state missing
    await rates({ country_code: 'US', state_code: 'XX', zip: '00000' }, [[11513, 1]]),
    await rates(ADDR, [[999999999, 1]]),
    await pf('POST', '/v2/shipping-rates', { json: { recipient: ADDR, order_items: [{ source: 'catalog', catalog_variant_id: '4651', quantity: 1 }] } }), // string id
  ]);

  const est = await pf('POST', '/v2/order-estimation-tasks', { json: { recipient: ADDR, order_items: draftItems([[4651, 1], [11513, 2]]) } });
  const estId = est.body?.data?.id;
  const estPolls = [];
  for (let i = 0; estId && i < 10; i++) { const r = await pf('GET', `/v2/order-estimation-tasks?id=${estId}`); estPolls.push(r); if (r.body?.data?.status !== 'pending') break; await sleep(2000); }
  save('printful-order-estimation', [est, ...estPolls]);

  await files();

  const mock = await pf('POST', '/v2/mockup-tasks', { json: { format: 'jpg', mockup_width_px: 1000, products: [{ source: 'catalog', catalog_product_id: 2, catalog_variant_ids: [4651], placements: [{ placement: 'default', technique: 'digital', layers: [{ type: 'file', url: FILE_URL }] }] }] } });
  const taskId = mock.body?.data?.[0]?.id;
  const mockPolls = [];
  for (let i = 0; taskId && i < 12; i++) { const r = await pf('GET', `/v2/mockup-tasks?id=${taskId}`); mockPolls.push(r); if (r.body?.data?.[0]?.status !== 'pending') break; await sleep(5000); }
  save('printful-mockup-task', [mock, ...mockPolls]);

  if (!skipDrafts) await printfulDrafts();
}

function draftItems(list) {
  return list.map(([variant, quantity], i) => ({
    source: 'catalog', catalog_variant_id: variant, quantity, external_id: `item${i + 1}`, retail_price: '10.00',
    placements: [{ placement: variant === 4012 ? 'front' : 'default', technique: variant === 1320 ? 'sublimation' : variant === 4012 ? 'dtg' : 'digital', layers: [{ type: 'file', url: FILE_URL }] }],
  }));
}

async function printfulDrafts() {
  const ext = `capture-${stamp}`;
  const ex = [];
  const create = await pf('POST', '/v2/orders', { json: { external_id: ext, shipping: 'STANDARD', recipient: ADDR, order_items: draftItems([[4651, 1], [11513, 2], [4012, 1]]), retail_costs: { currency: 'USD', shipping: '8.49' }, customization: { packing_slip: { store_name: 'Capture test', custom_order_id: 'S-TEST-0001' } } } });
  ex.push(create);
  const id = create.body?.data?.id ? String(create.body.data.id) : null;
  if (id) createdDrafts.add(id);
  try {
    if (id) {
      for (let i = 0; i < 15; i++) { const r = await pf('GET', `/v2/orders/${id}`); ex.push(r); if (r.body?.data?.costs?.calculation_status !== 'calculating') break; await sleep(2000); }
      ex.push(await pf('GET', `/v2/orders/@${ext}`));
      ex.push(await pf('GET', `/v2/orders/${id}/order-items`));
      ex.push(await pf('GET', `/v2/orders/${id}/shipments`));
      ex.push(await pf('GET', `/orders/@${ext}`));                                   // v1 view of the same draft
      ex.push(await pf('PATCH', `/v2/orders/${id}`, { json: { shipping: 'STANDARD', recipient: { ...ADDR, address2: 'Hall 1' } } }));
      const dup = await pf('POST', '/v2/orders', { json: { external_id: ext, recipient: ADDR, order_items: draftItems([[11513, 1]]) } }); // duplicate external_id
      ex.push(dup);
      const dupId = dup.body?.data?.id ? String(dup.body.data.id) : null;
      if (dupId && dupId !== id) { createdDrafts.add(dupId); ex.push(await pf('DELETE', `/v2/orders/${dupId}`)); }
    }
  } finally {
    if (id) { ex.push(await pf('DELETE', `/v2/orders/${id}`)); ex.push(await pf('GET', `/v2/orders/${id}`)); }
    save('printful-draft-order-lifecycle', ex);
  }

  // A second draft, cancelled through v1 DELETE (the call the shop uses to cancel), to capture that response.
  const ext2 = `capture-${stamp}-v1`;
  const ex2 = [];
  const c2 = await pf('POST', '/v2/orders', { json: { external_id: ext2, recipient: ADDR, order_items: draftItems([[11513, 1]]) } });
  ex2.push(c2);
  const id2 = c2.body?.data?.id ? String(c2.body.data.id) : null;
  if (id2) { createdDrafts.add(id2); ex2.push(await pf('DELETE', `/orders/${id2}`)); ex2.push(await pf('GET', `/v2/orders/${id2}`)); if (ex2.at(-1).status === 200) ex2.push(await pf('DELETE', `/v2/orders/${id2}`)); }
  save('printful-draft-v1-cancel', ex2);

  // Errors on creation: invalid address, unknown variant, bad file URL. Delete anything that got created.
  const bad = [];
  for (const [label, body] of [
    ['invalid-address', { external_id: `${ext}-a`, recipient: { name: 'X', address1: '1 Nowhere', city: 'Nowhere', state_code: 'ZZ', zip: '00000', country_code: 'US' }, order_items: draftItems([[11513, 1]]) }],
    ['unknown-variant', { external_id: `${ext}-b`, recipient: ADDR, order_items: draftItems([[999999999, 1]]) }],
    ['bad-file-url', { external_id: `${ext}-c`, recipient: ADDR, order_items: [{ ...draftItems([[11513, 1]])[0], placements: [{ placement: 'default', technique: 'digital', layers: [{ type: 'file', url: 'https://shop.klaushofrichter.net/files/does-not-exist.jpg' }] }] }] }],
  ]) {
    const r = await pf('POST', '/v2/orders', { json: body });
    r.label = label; bad.push(r);
    const bid = r.body?.data?.id ? String(r.body.data.id) : null;
    if (bid) { createdDrafts.add(bid); await sleep(3000); bad.push(await pf('GET', `/v2/orders/${bid}`)); bad.push(await pf('DELETE', `/v2/orders/${bid}`)); }
  }
  save('printful-draft-errors', bad);
}

// ---------- Printful file library: how a good and a broken file are reported (no cost) ----------
async function files() {
  const ex = [];
  for (const [label, url] of [['good', FILE_URL], ['unreachable', 'https://shop.klaushofrichter.net/files/does-not-exist.jpg'], ['not-an-image', 'https://art.klaushofrichter.net/health']]) {
    const reg = await pf('POST', '/v2/files', { json: { url } });
    reg.label = label; ex.push(reg);
    const id = reg.body?.data?.id;
    for (let i = 0; id && i < 12; i++) { const r = await pf('GET', `/v2/files/${id}`); r.label = label; ex.push(r); if (r.body?.data?.status !== 'waiting') break; await sleep(5000); }
  }
  save('printful-files', ex);
}

// ---------- Printful: does the cost estimate validate an address? (creates no order) ----------
async function estimationAddresses() {
  const items = draftItems([[11513, 1]]);
  const ex = [];
  for (const [label, recipient] of [
    ['valid', ADDR],
    ['state-zip-mismatch', { ...ADDR, state_code: 'NY' }],
    ['invalid-state', { ...ADDR, state_code: 'ZZ', zip: '00000' }],
    ['nonexistent-street', { ...ADDR, address1: '99999 Nonexistent Rd' }],
    ['missing-address1', { name: 'Capture Test', city: 'Austin', state_code: 'TX', zip: '78701', country_code: 'US' }],
  ]) {
    const r = await pf('POST', '/v2/order-estimation-tasks', { json: { recipient, order_items: items } });
    r.label = label; ex.push(r);
    const id = r.body?.data?.id;
    for (let i = 0; id && i < 10; i++) { const p = await pf('GET', `/v2/order-estimation-tasks?id=${id}`); p.label = label; ex.push(p); if (p.body?.data?.status !== 'pending') break; await sleep(2000); }
  }
  save('printful-estimation-addresses', ex);
}

// ---------- Stripe (test mode) ----------
async function stripe() {
  // Pin the version the shop will use (the stripe-node release's pinned version). The
  // account's default (2017-04-06 when first captured) has older response shapes.
  const ver = { 'Stripe-Version': String(args['stripe-version'] ?? '2026-11-18.endive') };
  const customer = await st('POST', '/v1/customers', { headers: ver, form: { email: 'capture-test@example.com', name: 'Capture Test', address: { line1: '500 E Cesar Chavez St', city: 'Austin', state: 'TX', postal_code: '78701', country: 'US' }, shipping: { name: 'Capture Test', address: { line1: '500 E Cesar Chavez St', city: 'Austin', state: 'TX', postal_code: '78701', country: 'US' } }, metadata: { order_id: `capture-${stamp}` } } });
  const cus = customer.body?.id;
  save('stripe-customer', [customer, cus ? await st('GET', `/v1/customers/${cus}`, { headers: ver }) : null].filter(Boolean));

  const session = (extra = {}) => ({
    mode: 'payment', customer: cus, client_reference_id: `capture-${stamp}`, metadata: { order_id: `capture-${stamp}` },
    payment_intent_data: { metadata: { order_id: `capture-${stamp}` } },
    line_items: { 0: { quantity: 1, price_data: { currency: 'usd', unit_amount: 5900, tax_behavior: 'exclusive', product_data: { name: 'Framed print 8 × 10 in, black frame — Undertow', tax_code: 'txcd_99999999' } } }, 1: { quantity: 4, price_data: { currency: 'usd', unit_amount: 400, tax_behavior: 'exclusive', product_data: { name: 'Postcard 4 × 6 in — Undertow', tax_code: 'txcd_99999999' } } } },
    shipping_options: { 0: { shipping_rate_data: { type: 'fixed_amount', display_name: 'Standard', fixed_amount: { amount: 849, currency: 'usd' }, tax_behavior: 'exclusive', tax_code: 'txcd_92010001', delivery_estimate: { minimum: { unit: 'business_day', value: 4 }, maximum: { unit: 'business_day', value: 7 } } } } },
    billing_address_collection: 'auto',
    success_url: 'https://shop.klaushofrichter.net/order/capture?t=x&from=checkout', cancel_url: 'https://shop.klaushofrichter.net/checkout/cancelled?o=capture',
    expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
    ...extra,
  });
  const ex = [];
  // The open questions of docs/design/13 §4: shipping_options without shipping_address_collection; tax from the Customer's address.
  const s1 = await st('POST', '/v1/checkout/sessions', { headers: { ...ver, 'Idempotency-Key': `capture-${stamp}-s1` }, form: session() });
  ex.push(s1);
  const s2 = await st('POST', '/v1/checkout/sessions', { headers: { ...ver, 'Idempotency-Key': `capture-${stamp}-s2` }, form: session({ automatic_tax: { enabled: true } }) });
  ex.push(s2);
  ex.push(await st('POST', '/v1/checkout/sessions', { headers: { ...ver, 'Idempotency-Key': `capture-${stamp}-s3` }, form: session({ automatic_tax: { enabled: true }, customer_update: { shipping: 'auto', address: 'auto' } }) }));
  ex.push(await st('POST', '/v1/checkout/sessions', { headers: { ...ver, 'Idempotency-Key': `capture-${stamp}-s4` }, form: session({ shipping_address_collection: { allowed_countries: { 0: 'US' } } }) }));
  ex.push(await st('POST', '/v1/checkout/sessions', { headers: { ...ver, 'Idempotency-Key': `capture-${stamp}-s1` }, form: session({ client_reference_id: 'different' }) })); // idempotency conflict
  ex.push(await st('POST', '/v1/checkout/sessions', { headers: ver, form: { mode: 'payment', line_items: { 0: { quantity: 1, price_data: { currency: 'usd', unit_amount: -1, product_data: { name: 'x' } } } } } })); // bad parameter
  const sid = s1.body?.id ?? s2.body?.id;
  if (sid) {
    ex.push(await st('GET', `/v1/checkout/sessions/${sid}?expand[]=payment_intent&expand[]=line_items`, { headers: ver }));
    ex.push(await st('POST', `/v1/checkout/sessions/${sid}/expire`, { headers: ver }));
    ex.push(await st('GET', `/v1/checkout/sessions/${sid}`, { headers: ver }));
  }
  save('stripe-checkout-sessions', ex);

  save('stripe-tax-codes', [await st('GET', '/v1/tax_codes?limit=100', { headers: ver }), await st('GET', '/v1/tax_codes/txcd_30011000', { headers: ver })]);
  save('stripe-events', [await st('GET', '/v1/events?limit=10', { headers: ver })]);
  save('stripe-errors', [await st('GET', '/v1/checkout/sessions/cs_test_doesnotexist', { headers: ver }), await st('POST', '/v1/refunds', { headers: ver, form: { payment_intent: 'pi_doesnotexist' } })]);
}

// ---------- self-test of the guards (no network, no keys) ----------
async function selfTest() {
  const refused = (m, p) => { const exit = process.exit; let code = null; process.exit = (c) => { code = c; throw new Error('exit'); };
    try { assertPrintfulAllowed(m, p); } catch {} finally { process.exit = exit; } return code === 1; };
  const quiet = console.error; console.error = () => {};
  const cases = [
    ['POST', '/v2/orders/123/confirmation', true], ['POST', '/v2/orders/123/confirm', true], ['POST', '/orders/123/confirm', true],
    ['POST', '/orders?confirm=true', true], ['POST', '/orders', true], ['DELETE', '/v2/orders/555', true], ['PATCH', '/v2/orders/555', true],
    ['DELETE', '/v2/webhooks', true], ['POST', '/v2/webhooks', true], ['PUT', '/v2/orders/1', true],
    ['POST', '/v2/orders', false], ['GET', '/v2/orders/@capture-abc', false], ['POST', '/v2/shipping-rates', false],
  ];
  createdDrafts.add('777');
  cases.push(['DELETE', '/v2/orders/777', false], ['DELETE', '/orders/777', false]);
  let bad = 0;
  for (const [m, p, expectRefused] of cases) if (refused(m, p) !== expectRefused) { bad++; quiet(`self-test FAILED: ${m} ${p} expected ${expectRefused ? 'refused' : 'allowed'}`); }
  console.error = quiet;
  if (!/^(rk|sk)_test_/.test('rk_test_x') || /^(rk|sk)_test_/.test('rk_live_x')) bad++;
  // output location: inside the public repository is refused, outside is allowed
  if (!insideRepo(REPO_ROOT) || !insideRepo(join(REPO_ROOT, 'captures', 'x')) || insideRepo(resolve(REPO_ROOT, '..', 'shop-private', 'captures'))) { bad++; quiet('self-test FAILED: output location check'); }
  console.log(bad ? `self-test: ${bad} failure(s)` : `self-test: all ${cases.length + 3} guard cases pass`);
  if (bad) process.exit(1);
}

// ---------- run ----------
if (args['self-test']) { await selfTest(); process.exit(0); }
if (!outDir) die('--out is required: a directory in a checkout of the private repository (ADR-0028)');
if (insideRepo(outDir)) die(`--out ${outDir} is inside the public repository; raw captures go to the private repository (ADR-0028)`);
mkdirSync(outDir, { recursive: true });
try {
  if (only.includes('printful')) await printful();
  if (only.includes('estimation')) await estimationAddresses();
  if (only.includes('files')) await files();
  if (only.includes('stripe')) await stripe();
} finally {
  writeFileSync(join(outDir, 'SUMMARY.txt'), log.join('\n') + '\n');
  console.log(log.join('\n'));
  if (createdDrafts.size) console.log(`Printful drafts created (each deleted above; check the DELETE statuses): ${[...createdDrafts].join(', ')}`);
}
