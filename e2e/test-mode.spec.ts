import { expect, test, type Page } from '@playwright/test';

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

/** Stripe Checkout's card form (field ids as of 2026; the page is Stripe's). */
async function payWith(page: Page, card: string) {
  const email = page.locator('#email');
  if ((await email.count()) && (await email.isEditable())) await email.fill(SIM('success'));
  await page.locator('#cardNumber').fill(card);
  await page.locator('#cardExpiry').fill('12 / 34');
  await page.locator('#cardCvc').fill('123');
  await page.locator('#billingName').fill('Test Mode');
  const zip = page.locator('#billingPostalCode');
  if (await zip.count()) await zip.fill('78701');
  await page.locator('[data-testid="hosted-payment-submit-button"], button.SubmitButton').first().click();
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
  await expect(page.getByText(/card (was|has been) declined/i)).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(/^https:\/\/checkout\.stripe\.com\//);
});

test('4: cancel and return brings the cart back', async ({ page }) => {
  test.setTimeout(180_000);
  await toStripe(page, SIM('success'));
  await page.locator('a[href*="shop.klaushofrichter.net/cart"], [data-testid="business-link"]').first().click();
  await expect(page).toHaveURL(/\/cart\?from=checkout$/, { timeout: 30_000 });
  await expect(page.locator(`input[name="sku"][value="${SKU}"]`).first()).toBeAttached(); // the item is still in the cart
});

test('4: 3-D Secure, completed in Stripe test challenge', async ({ page }) => {
  test.setTimeout(240_000);
  await toStripe(page, SIM('success'));
  await payWith(page, '4000 0027 6000 3184');
  const challenge = page.frameLocator('iframe[name^="__privateStripeFrame"]').first().frameLocator('iframe#challengeFrame');
  await challenge.getByRole('button', { name: /complete/i }).click({ timeout: 60_000 });
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
