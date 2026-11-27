import { writeFileSync } from 'node:fs';
import { expect, test, type Frame, type Locator, type Page } from '@playwright/test';

// docs/design/12 §3 items 3, 4 and 6, and 14 §7.4: the shop in TEST mode on the
// cluster, through Stripe's real test-mode Checkout page and the Printful test
// store (drafts only; test mode never confirms). Run by Cluster on the node, by
// hand, never in CI:
//
//   TEST_MODE_RUN=1 BASE_URL=https://shop.klaushofrichter.net PREVIEW_KEY=… TEST_WORK=<a sellable work id> \
//     npx playwright test e2e/test-mode.spec.ts --project desktop-chromium --trace off
//
// PREVIEW_KEY is read from the node's .env without printing it. The customer
// addresses are SES mailbox simulator addresses (on EMAIL_ALLOWLIST), so nothing
// reaches a real person: success@ is delivered, bounce@ and complaint@ send
// their notices to the feedback address (Klaus checks that mailbox), and
// suppressionlist@ is refused by SES. Every paid order here is a test-mode
// payment and a draft in the test store.

/**
 * Each run buys with its own addresses and rotates its test cards: the repeat-order
 * fail-safe (REPEAT_ORDERS per 24 hours) counts paid orders per e-mail and per card,
 * and must not hold these. The shop allows `box+tag@` when `box@` is on EMAIL_ALLOWLIST
 * (test mode only); SES's simulator accepts the +tag.
 */
const RUN = Number(process.env.TEST_RUN_INDEX ?? Math.floor(Date.now() / 60_000));
const SIM = (box: string, tag = 'x') => `${box}+r${RUN.toString(36)}-${tag}@simulator.amazonses.com`;
const CARDS = [
  '4242 4242 4242 4242', '4000 0566 5566 5556', '5555 5555 5555 4444', '2223 0031 2200 3222', '5200 8282 8282 8210',
  '5105 1051 0510 5100', '6011 1111 1111 1117', '6011 0009 9013 9424', '3056 9300 0902 0004', '3566 0020 2036 0505',
];
/** The run's n-th card (0–3): four per run, moving on by four each run. */
const card = (n: number) => CARDS[(RUN * 4 + n) % CARDS.length];
const CARDS_3DS = ['4000 0027 6000 3184', '4000 0000 0000 3220'];
const SKU = process.env.TEST_SKU ?? 'print-8x10';

test.describe.configure({ mode: 'serial' });

test.beforeEach(({ baseURL }, info) => {
  test.skip(!process.env.TEST_MODE_RUN, 'only when Cluster runs the test-mode check (TEST_MODE_RUN=1)');
  test.skip(info.project.name !== 'desktop-chromium', 'desktop Chromium only');
  test.skip(!baseURL?.startsWith('https://'), 'against the deployed test-mode shop only');
  if (!process.env.PREVIEW_KEY || !process.env.TEST_WORK) throw new Error('PREVIEW_KEY and TEST_WORK are required');
});

async function throughGate(page: Page) {
  await page.goto('/preview');
  await page.getByLabel('Preview key').fill(process.env.PREVIEW_KEY!);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).not.toHaveURL(/\/preview$/);
}

/** Picture page → cart → address → quote → Stripe's hosted page. */
async function toStripe(page: Page, email: string) {
  await throughGate(page);
  await page.goto(`/p/art/${process.env.TEST_WORK}`);
  const form = page.locator('form', { has: page.locator(`input[name="sku"][value="${SKU}"]`) });
  await form.getByRole('button', { name: 'Add to cart' }).click();
  await expect(page).toHaveURL(/\/cart$/);
  await page.getByLabel('Full name').fill('Test Mode');
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Address line 1').fill('100 Congress Ave');
  await page.getByLabel('City').fill('Austin');
  await page.getByLabel('State').selectOption('TX');
  await page.getByLabel('ZIP code').fill('78701');
  await page.getByRole('button', { name: 'See shipping and total' }).click();
  await expect(page).toHaveURL(/\/quote$/);
  await expect(page.getByText(/Total before tax: \$/)).toBeVisible();
  await page.getByRole('button', { name: 'Pay with Stripe' }).click();
  await expect(page).toHaveURL(/^https:\/\/checkout\.stripe\.com\//, { timeout: 30_000 });
}

type Scope = Page | Frame;

/**
 * The first visible match of `build` in the page or any of its frames (Stripe's
 * Checkout puts its payment form in an iframe, and the card fields or the 3-D
 * Secure challenge may sit in further nested ones; page.frames() lists them all).
 */
async function inAnyFrame(page: Page, build: (s: Scope) => Locator[], ms = 15_000): Promise<Locator | undefined> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    for (const scope of [page as Scope, ...page.frames()]) {
      for (const c of build(scope)) if (await c.first().isVisible().catch(() => false)) return c.first();
    }
    await page.waitForTimeout(250);
  }
  return undefined;
}

/** On a miss: a screenshot and every frame's ARIA snapshot in the report, then the error. */
async function missing(page: Page, what: string): Promise<never> {
  const info = test.info();
  // Written under test-results/ as well as attached, so whoever runs this can read them.
  const png = info.outputPath('stripe-page.png');
  await page.screenshot({ path: png, fullPage: true });
  await info.attach('stripe-page.png', { path: png, contentType: 'image/png' });
  const parts: string[] = [];
  for (const f of page.frames()) {
    const snap = await f.locator('body').ariaSnapshot({ timeout: 2_000 }).catch(() => '(no snapshot)');
    parts.push(`--- frame ${f.name() || '(unnamed)'} ${f.url().split('?')[0]}\n${snap}`);
  }
  const txt = info.outputPath('stripe-frames.txt');
  writeFileSync(txt, parts.join('\n\n'));
  await info.attach('stripe-frames.txt', { path: txt, contentType: 'text/plain' });
  throw new Error(`Stripe page: ${what} not found (see stripe-page.png and stripe-frames.txt)`);
}

async function fill(page: Page, what: string, value: string, build: (s: Scope) => Locator[], required = true) {
  const field = await inAnyFrame(page, build, required ? 15_000 : 3_000);
  if (field) await field.fill(value);
  else if (required) await missing(page, what);
}

/**
 * Stripe Checkout as of 2026-11: the payment form is in an iframe; payment methods
 * are buttons (Card, and Link's bank option); the card fields appear once Card is
 * chosen; the terms consent (consent_collection) is a checkbox to tick before Pay.
 */
async function payWith(page: Page, card: string) {
  const cardNumber = (s: Scope) => [s.locator('#cardNumber'), s.getByLabel(/card number/i), s.getByPlaceholder('1234 1234 1234 1234')];
  if (!(await inAnyFrame(page, cardNumber, 2_000))) {
    const choose = await inAnyFrame(page, (s) => [
      s.getByRole('button', { name: 'Card', exact: true }),
      s.getByRole('radio', { name: /^card$/i }),
      s.getByTestId('card-accordion-item-button'),
    ]);
    if (!choose) await missing(page, 'the "Card" payment option');
    await choose!.click();
  }
  await fill(page, 'the card number field', card, cardNumber);
  await fill(page, 'the expiry field', '12 / 34', (s) => [s.locator('#cardExpiry'), s.getByLabel(/expiration|expiry/i), s.getByPlaceholder('MM / YY')]);
  await fill(page, 'the CVC field', '123', (s) => [s.locator('#cardCvc'), s.getByLabel(/^CVC|security code/i), s.getByPlaceholder('CVC')]);
  await fill(page, 'the cardholder name', 'Test Mode', (s) => [s.locator('#billingName'), s.getByLabel(/cardholder name|name on card/i)], false);
  await fill(page, 'the ZIP field', '78701', (s) => [s.locator('#billingPostalCode'), s.getByLabel(/^ZIP|postal code/i)], false);
  // Link's "Save my information" (if Stripe still offers it): off, so Pay doesn't wait for a phone number.
  const save = await inAnyFrame(page, (s) => [s.getByRole('checkbox', { name: /save my information/i })], 1_000);
  if (save && (await save.isChecked().catch(() => false))) await save.click();
  // The terms consent: a styled box covers the input and its label holds two links, so a
  // click can miss or follow a link. Focus the checkbox and press Space, as a keyboard user
  // would; fall back to the label's left edge.
  const consent = await inAnyFrame(page, (s) => [s.getByRole('checkbox', { name: /I agree/i }), s.locator('input[name="termsOfServiceConsent"]')], 5_000);
  if (!consent) await missing(page, 'the terms consent checkbox');
  if (!(await consent!.isChecked().catch(() => false))) {
    await consent!.focus();
    await page.keyboard.press('Space');
  }
  if (!(await consent!.isChecked().catch(() => false))) {
    const label = await inAnyFrame(page, (s) => [s.getByText(/^I agree to /i)], 2_000);
    if (label) await label.click({ position: { x: 2, y: 6 } });
  }
  if (!(await consent!.isChecked().catch(() => false))) await missing(page, 'a ticked terms consent checkbox');
  const pay = await inAnyFrame(page, (s) => [s.getByRole('button', { name: 'Pay', exact: true }), s.getByTestId('hosted-payment-submit-button'), s.locator('button.SubmitButton')], 5_000);
  if (!pay) await missing(page, 'the Pay button');
  await pay!.click();
}

/** Back at the shop's order page: paid, then a draft in the test store ("Test order"). */
async function expectTestOrder(page: Page) {
  await expect(page).toHaveURL(/shop\.klaushofrichter\.net\/order\/[^/?]+/, { timeout: 60_000 });
  await expect(page.getByText(/Order \d{5}/).first()).toBeVisible();
  await expect(async () => {
    await page.reload();
    await expect(page.getByText('Test order — nothing is produced')).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 120_000 });
}

test('3: a purchase with a test card becomes a test-store draft; the e-mails go to success@', async ({ page }) => {
  test.setTimeout(240_000);
  await toStripe(page, SIM('success', 'buy'));
  await payWith(page, card(0));
  await expectTestOrder(page);
});

test('4: a declined card stays on Stripe with its message', async ({ page }) => {
  test.setTimeout(180_000);
  await toStripe(page, SIM('success'));
  await payWith(page, '4000 0000 0000 0002');
  const declined = await inAnyFrame(page, (s) => [s.getByText(/card (was|has been) declined/i)], 30_000);
  if (!declined) await missing(page, 'the decline message');
  await expect(page).toHaveURL(/^https:\/\/checkout\.stripe\.com\//);
});

test('4: cancel and return brings the cart back', async ({ page }) => {
  test.setTimeout(180_000);
  await toStripe(page, SIM('success'));
  await page.locator('a[href*="/cart?from=checkout"], [data-testid="business-link"]').first().click();
  await expect(page).toHaveURL(/\/cart\?from=checkout$/, { timeout: 30_000 });
  await expect(page.locator(`input[name="sku"][value="${SKU}"]`).first()).toBeAttached(); // the item is still in the cart
});

test('4: 3-D Secure, completed in Stripe test challenge', async ({ page }) => {
  test.setTimeout(240_000);
  await toStripe(page, SIM('success', '3ds'));
  await payWith(page, CARDS_3DS[RUN % CARDS_3DS.length]);
  // Stripe's test 3-D Secure page sits in a frame named "stripe-challenge-frame" (URL
  // …/3d_secure_2_test/…) inside Stripe's challenge frame. Find it by name or URL (its
  // heading need not count as visible), wait for its "Complete" button (the upper case on
  // screen is CSS), click it, and click once more if the challenge is still there.
  const challengeFrame = (): Frame | undefined =>
    page.frames().find((f) => !f.isDetached() && (f.name() === 'stripe-challenge-frame' || f.url().includes('/3d_secure_2_test/')));
  let frame: Frame | undefined;
  for (let i = 0; i < 120 && !frame; i++) {
    frame = challengeFrame();
    if (!frame) await page.waitForTimeout(500);
  }
  if (!frame) await missing(page, 'the 3-D Secure test page');
  for (let attempt = 0; attempt < 2; attempt++) {
    const complete = frame!.getByRole('button', { name: /^complete$/i }).or(frame!.locator('#test-source-authorize-3ds')).first();
    await complete.waitFor({ state: 'visible', timeout: 30_000 });
    await complete.click();
    const gone = await expect
      .poll(() => !challengeFrame(), { timeout: 15_000 })
      .toBe(true)
      .then(() => true, () => false);
    if (gone || page.url().includes('shop.klaushofrichter.net/order/')) break;
    if (attempt === 1) await missing(page, 'a 3-D Secure challenge that closes after Complete');
    frame = challengeFrame() ?? frame;
  }
  await expectTestOrder(page);
});

// A different test card per order and per run (see CARDS above).
for (const [box, n] of [
  ['bounce', 1],
  ['complaint', 2],
  ['suppressionlist', 3],
] as const) {
  test(`6: an order mailed to ${box}@ (the notice, if any, reaches the feedback address)`, async ({ page }) => {
    test.setTimeout(240_000);
    await toStripe(page, SIM(box));
    await payWith(page, card(n));
    await expectTestOrder(page);
  });
}
