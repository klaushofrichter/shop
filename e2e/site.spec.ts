import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/** Console errors and failed requests fail a test: Lighthouse's best-practices
 *  floor (100) would catch them too, later and less precisely. */
function watchProblems(page: import('@playwright/test').Page): string[] {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`request failed: ${r.url()}`));
  return problems;
}

async function audit(page: import('@playwright/test').Page) {
  const result = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(
    result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
    'WCAG 2.2 AA violations',
  ).toEqual([]);
  // The pages have no text over pictures or gradients yet, so axe decides
  // every contrast itself; an undecided one means that changed.
  expect(result.incomplete.filter((r) => r.id === 'color-contrast').length, 'undecided contrast').toBe(0);
}

test('@live /health reports the expected version', async ({ request }) => {
  const res = await request.get('/health');
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.status).toBe('ok');
  if (process.env.EXPECT_VERSION) expect(body.version).toBe(process.env.EXPECT_VERSION);
});

/** The live site sits behind the preview gate until go-live (ADR-0039); live-check.yml
 *  says so with PREVIEW_GATE=on, and turning it off is a go-live box (12 §4). */
const gated = process.env.PREVIEW_GATE === 'on';

test('@live the home page loads cleanly, links to the gallery and meets WCAG 2.2 AA', async ({ page }) => {
  test.skip(gated, 'behind the preview gate until go-live');
  const problems = watchProblems(page);
  const res = await page.goto('/');
  expect(res?.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: 'art.klaushofrichter.net' }).first()).toHaveAttribute(
    'href',
    'https://art.klaushofrichter.net/',
  );
  await audit(page);
  expect(problems).toEqual([]);
});

test('@live an unknown path answers 404 with a page that meets WCAG 2.2 AA', async ({ page }) => {
  test.skip(gated, 'behind the preview gate until go-live');
  const res = await page.goto('/does-not-exist');
  expect(res?.status()).toBe(404);
  await expect(page.getByRole('link', { name: 'Back to the shop' })).toBeVisible();
  await audit(page);
});

test('@live the preview gate holds every page and its own page meets WCAG 2.2 AA', async ({ page, request }) => {
  test.skip(!gated, 'the gate is off');
  for (const path of ['/', '/does-not-exist', '/cart']) {
    const res = await request.get(path, { maxRedirects: 0 });
    expect(res.status(), path).toBe(401);
    expect(await res.text(), path).toContain('<h1>Preview</h1>');
  }
  const problems = watchProblems(page);
  const res = await page.goto('/preview');
  expect(res?.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1, name: 'Preview' })).toBeVisible();
  await expect(page.getByLabel('Preview key')).toBeVisible();
  await expect(page.getByRole('link', { name: 'art.klaushofrichter.net' }).first()).toHaveAttribute('href', 'https://art.klaushofrichter.net/');
  await audit(page);
  expect(problems).toEqual([]);
});

test('@live text arrives compressed', async ({ request }) => {
  const res = await request.get('/', { headers: { 'Accept-Encoding': 'gzip, br' } });
  expect(['gzip', 'br']).toContain(res.headers()['content-encoding']);
});

test('nothing scrolls sideways on a phone', async ({ page }) => {
  await page.goto('/');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
