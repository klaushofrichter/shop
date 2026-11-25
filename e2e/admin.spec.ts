import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { signSession } from '../src/admin/session';
import { E2E_COOKIE_SECRET } from '../playwright.config';

// docs/design/12 §1: the admin e2e mints a real signed session cookie with the
// e2e job's COOKIE_SECRET; the application has no test login route. Chromium
// only. Never against the live site.

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

test.beforeEach(async ({ context, baseURL }, info) => {
  test.skip(info.project.name !== 'desktop-chromium', 'admin: desktop Chromium only');
  test.skip(!!baseURL?.startsWith('https://'), 'never against the live site');
  const exp = Date.now() + 60 * 60_000;
  await context.addCookies([
    { name: 'shop_admin', value: signSession(E2E_COOKIE_SECRET, { email: 'e2e@example.com', exp }), url: baseURL!, httpOnly: true, secure: true, sameSite: 'Lax' },
  ]);
});

test('the admin dashboard, orders and works pages load signed in, no-store, accessible', async ({ page }) => {
  const res = await page.goto('/admin');
  expect(res?.status()).toBe(200);
  expect(res?.headers()['cache-control']).toBe('no-store');
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  await expect(page.getByText('MOCK', { exact: true })).toBeVisible();
  const axe = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(axe.violations.map((v) => v.id)).toEqual([]);

  await page.getByRole('navigation', { name: 'Admin' }).getByRole('link', { name: 'Orders' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Orders' })).toBeVisible();
  const axeOrders = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(axeOrders.violations.map((v) => v.id)).toEqual([]);

  await page.getByRole('navigation', { name: 'Admin' }).getByRole('link', { name: 'Works' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Works' })).toBeVisible();
  const axe2 = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(axe2.violations.map((v) => v.id)).toEqual([]);
});

test('sign out really signs out: a 200 page with a Sign in link, and /admin asks to sign in again', async ({ page, context }) => {
  await page.goto('/admin');
  await page.getByRole('link', { name: 'Sign out' }).click();
  await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
  expect((await context.cookies()).find((c) => c.name === 'shop_admin')).toBeUndefined();
  const res = await page.goto('/admin');
  expect(page.url()).toMatch(/\/admin\/login$/);
  expect(res?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Shop admin' })).toBeVisible();
});
