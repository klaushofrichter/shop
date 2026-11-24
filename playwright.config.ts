import { defineConfig, devices } from '@playwright/test';

/**
 * kube-setup's "public web pages" baseline (docs/cluster-deployment-requirements.md
 * §4), adapted from klaushofrichter/art:
 *  - nothing set: Playwright builds and starts the server itself;
 *  - BASE_URL=http://localhost:8080: a server somebody else started, in
 *    production-checks.yml the Docker image the release will ship;
 *  - BASE_URL=https://shop.klaushofrichter.net with --grep @live: the live
 *    site (read-only tests only).
 */
const BASE_URL = process.env.BASE_URL;
const LIVE = BASE_URL?.startsWith('https://');

const chromiumLaunch = process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {};

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  // One retry absorbs a runner hiccup, but a test that needed it still fails
  // the run: "passed on retry" has been a real layout bug before (vault, Gotchas).
  retries: process.env.CI ? 1 : 0,
  failOnFlakyTests: !!process.env.CI,
  forbidOnly: !!process.env.CI,
  timeout: LIVE ? 60_000 : 30_000,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: BASE_URL || 'http://localhost:8080',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  // Desktop Chrome, an Android phone, an iPhone (WebKit) and desktop Firefox.
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'], launchOptions: chromiumLaunch } },
    { name: 'phone-chromium', use: { ...devices['Pixel 7'], launchOptions: chromiumLaunch } },
    { name: 'phone-webkit', use: { ...devices['iPhone 13'] } },
    { name: 'desktop-firefox', use: { ...devices['Desktop Firefox'] } },
  ],
  webServer: BASE_URL
    ? undefined
    : {
        command: 'npm run build && node dist/src/server.js',
        url: 'http://localhost:8080/health',
        env: { PORT: '8080' },
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
      },
});
