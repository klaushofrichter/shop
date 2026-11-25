import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { signSession } from '../src/admin/session';
import { E2E_COOKIE_SECRET } from '../playwright.config';

// docs/design/12 §1 and 13 §1 step 6: a whole purchase in a browser, in mock
// mode, against the mock services of mocks/server.ts (fake art, mock Printful,
// mock Stripe, whose checkout page the shop passes through under
// /__mock-pages/). Klaus's part first (enable a work, offer a print), then a
// customer's: picture page, cart, address, quote, Stripe, order page; then the
// order reaches mock Printful and is confirmed (step 7).
// Desktop Chromium only; only where the mocks run (E2E_MOCKS=1).

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const WORK = 'e2eblue1';
const SKU = 'print-8x10';

test.describe.configure({ mode: 'serial' });

test.beforeEach(({ baseURL }, info) => {
  test.skip(info.project.name !== 'desktop-chromium', 'purchase: desktop Chromium only');
  test.skip(!process.env.E2E_MOCKS, 'needs the mock services (E2E_MOCKS=1)');
  test.skip(!!baseURL?.startsWith('https://'), 'never against the live site');
});

/** Reload until `check` passes: the job runner works in the background. */
async function until(page: Page, url: string, check: () => Promise<boolean>, timeoutMs = 90_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    await page.goto(url);
    if (await check()) return;
    if (Date.now() > end) throw new Error(`timed out waiting on ${url}`);
    await page.waitForTimeout(2_000);
  }
}

test('Klaus offers a print, a customer buys it, the order page shows the payment', async ({ browser, baseURL }) => {
  test.setTimeout(240_000);

  // ---- Klaus: enable the work and offer the 8 × 10 print ----
  const admin = await browser.newContext();
  await admin.addCookies([
    { name: 'shop_admin', value: signSession(E2E_COOKIE_SECRET, { email: 'e2e@example.com', exp: Date.now() + 3_600_000 }), url: baseURL!, httpOnly: true, secure: true, sameSite: 'Lax' },
  ]);
  const a = await admin.newPage();
  // The sources refresh lists the fake art's works.
  await until(a, '/admin/works', async () => (await a.locator(`a[href="/admin/works/art/${WORK}"]`).count()) > 0);
  const work = a.locator('li.work', { has: a.locator(`a[href="/admin/works/art/${WORK}"]`) });
  if (await work.getByRole('button', { name: 'Enable' }).count()) await work.getByRole('button', { name: 'Enable' }).click();
  // The original is checked, then the offer can be saved.
  const workUrl = `/admin/works/art/${WORK}`;
  await until(a, workUrl, async () => !(await a.getByText('original not checked yet').count()));
  const offer = a.locator('section.offer', { has: a.locator(`#o-${SKU}`) });
  await offer.getByLabel('Offer this product').check();
  await offer.getByRole('button', { name: 'Save' }).click();
  // Rendered, registered at (mock) Printful, checked in its catalog: sellable.
  await until(a, workUrl, async () => (await a.locator('section.offer', { has: a.locator(`#o-${SKU}`) }).getByText('Sellable', { exact: true }).count()) > 0);
  await admin.close();

  // ---- A customer ----
  const customer = await browser.newContext();
  const page = await customer.newPage();
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('response', (r) => {
    if (r.status() >= 400) problems.push(`${r.status()} ${new URL(r.url()).pathname}`);
  });
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`);
  });

  await page.goto(`/p/art/${WORK}`);
  await expect(page.getByRole('heading', { level: 1, name: 'E2E Blue' })).toBeVisible();
  await page.locator('form', { has: page.locator(`input[name="sku"][value="${SKU}"]`) }).getByRole('button', { name: 'Add to cart' }).click();
  await expect(page).toHaveURL(/\/cart$/);
  await expect(page.getByText('Art print 8 × 10 in')).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze()).violations.map((v) => v.id)).toEqual([]);

  await page.getByLabel('Full name').fill('Jane Doe');
  await page.getByLabel('E-mail').fill('jane@example.com');
  await page.getByLabel('Address line 1').fill('1 Main St');
  await page.getByLabel('City').fill('Austin');
  await page.getByLabel('State').selectOption('TX');
  await page.getByLabel('ZIP code').fill('78701');
  await page.getByRole('button', { name: 'See shipping and total' }).click();

  await expect(page).toHaveURL(/\/quote$/);
  await expect(page.getByText(/Total before tax: \$/)).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze()).violations.map((v) => v.id)).toEqual([]);
  await page.getByRole('button', { name: 'Pay with Stripe' }).click();

  // Mock Stripe's page, on the shop's own origin.
  await expect(page).toHaveURL(/\/__mock-pages\/stripe\/checkout\/cs_mock_/);
  await expect(page.getByRole('heading', { name: 'Mock Stripe checkout' })).toBeVisible();
  await expect(page.getByText('Ships to Jane Doe, 1 Main St, Austin, TX 78701')).toBeVisible();
  await page.getByRole('button', { name: 'Pay' }).click();

  // Back at the shop: the order page, paid (the page confirms with Stripe itself if the webhook is slower).
  await expect(page).toHaveURL(/\/order\/[^/?]+$/);
  await expect(page.getByText(/Order \d{5}/).first()).toBeVisible();
  await expect(async () => {
    await page.reload();
    // Submission runs in the background: the order may already be with (mock) Printful.
    await expect(page.getByText(/Payment received — we're checking your order|In preparation/)).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
  expect((await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze()).violations.map((v) => v.id)).toEqual([]);

  const orderUrl = page.url();

  // The cart is empty after the payment.
  await page.goto('/cart');
  await expect(page.getByText('Art print 8 × 10 in')).toHaveCount(0);

  // The job runner submits the order to (mock) Printful and confirms it: "In preparation".
  await expect(async () => {
    await page.goto(orderUrl);
    await expect(page.getByText('In preparation')).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 60_000 });
  expect(problems).toEqual([]);
  await customer.close();
});
