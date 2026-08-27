import { defineConfig, devices } from '@playwright/test';

const DEFAULT_STAGING_URL = 'https://suas.zer0state-noema.workers.dev';
const baseURL = process.env.SUAS_E2E_BASE_URL ?? DEFAULT_STAGING_URL;

function assertSafeAcceptanceTarget(value: string): void {
  const url = new URL(value);
  const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !isLocal) {
    throw new Error('SUAS_E2E_BASE_URL must use HTTPS unless it targets localhost.');
  }
  if (/\b(prod|production|live)\b/i.test(`${url.hostname}${url.pathname}`)) {
    throw new Error(
      'SUAS browser acceptance refuses targets marked prod/production/live. ' +
        'ENVIRONMENT.md §2 and §5 require synthetic TEST/STAGING data.',
    );
  }
}

assertSafeAcceptanceTarget(baseURL);

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: 'artifacts/playwright/results',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  forbidOnly: true,
  retries: process.env.CI === 'true' ? 2 : 0,
  workers: 1,
  reporter: [['list'], ['html', { outputFolder: 'artifacts/playwright/report', open: 'never' }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
