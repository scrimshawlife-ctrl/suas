import { defineConfig, devices } from '@playwright/test';
import { API_PORT, API_URL, WEB_PORT, WEB_URL } from './e2e/config';

/**
 * End-to-end suite for the web app against the LOCAL fake stack (not the staging suite
 * at the repo root). `webServer` builds the stack from scratch: e2e/stack.ts resets the
 * database, migrates, seeds and starts the API, then Vite serves the app and proxies
 * /api to it. Run with `npm run test:e2e`.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '*.spec.ts',
  outputDir: './e2e-results/output',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: './e2e-results/report', open: 'never' }]],
  use: {
    baseURL: WEB_URL,
    viewport: { width: 1280, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } },
    },
  ],
  webServer: [
    {
      command: 'node --import tsx/esm e2e/stack.ts',
      url: `${API_URL}/api/v0/health`,
      timeout: 180_000,
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: `npm run dev -- --port ${String(WEB_PORT)}`,
      url: WEB_URL,
      timeout: 60_000,
      reuseExistingServer: false,
      env: { SUAS_API_PORT: String(API_PORT) },
    },
  ],
});
