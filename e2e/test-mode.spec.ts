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

const SIM = (box: string) => `${box}@simulator.amazonses.com`;
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
  await info.attach('stripe-page.png', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
  const parts: string[] = [];
  for (const f of page.frames()) {
    const snap = await f.locator('body').ariaSnapshot({ timeout: 2_000 }).catch(() => '(no snapshot)');
    parts.push(`--- frame ${f.name() || '(unnamed)'} ${f.url().split('?')[0]}\n${snap}`);
  }
  await info.attach('stripe-frames.txt', { body: parts.join('\n\n'), contentType: 'text/plain' });
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
  // The terms consent: a styled checkbox whose input is covered, so click its label as a person would.
  const consent = await inAnyFrame(page, (s) => [s.getByRole('checkbox', { name: /I agree/i }), s.locator('input[name="termsOfServiceConsent"]')], 5_000);
  if (!consent) await missing(page, 'the terms consent checkbox');
  if (!(await consent!.isChecked().catch(() => false))) {
    const label = await inAnyFrame(page, (s) => [s.getByText(/^I agree to /i)], 2_000);
    await (label ?? consent!).click();
    if (!(await consent!.isChecked().catch(() => false))) await missing(page, 'a ticked terms consent checkbox');
  }
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

test('3: a purchase with card 4242 becomes a test-store draft; the e-mails go to success@', async ({ page }) => {
  test.setTimeout(240_000);
  await toStripe(page, SIM('success'));
  await payWith(page, '4242 4242 4242 4242');
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
  await toStripe(page, SIM('success'));
  await payWith(page, '4000 0027 6000 3184');
  // Stripe's test 3-D Secure page, in nested iframes: "Complete" authorises.
  const complete = await inAnyFrame(page, (s) => [s.getByRole('button', { name: /^complete/i }), s.locator('#test-source-authorize-3ds')], 60_000);
  if (!complete) await missing(page, 'the 3-D Secure "Complete" button');
  await complete!.click();
  await expectTestOrder(page);
});

// A different test card per order: the repeat-order fail-safe counts paid orders per
// card and per e-mail within 24 hours (REPEAT_ORDERS), and these must not be held.
for (const [box, card] of [
  ['bounce', '5555 5555 5555 4444'],
  ['complaint', '6011 1111 1111 1117'],
  ['suppressionlist', '3056 9300 0902 0004'],
] as const) {
  test(`6: an order mailed to ${box}@ (the notice, if any, reaches the feedback address)`, async ({ page }) => {
    test.setTimeout(240_000);
    await toStripe(page, SIM(box));
    await payWith(page, card);
    await expectTestOrder(page);
  });
}
