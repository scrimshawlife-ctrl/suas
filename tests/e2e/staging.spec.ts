/**
 * Deployed synthetic-STAGING browser acceptance.
 *
 * SUAS-specs ENVIRONMENT.md §2/§5: no production data or real support effects.
 * TESTING.md §11: readiness evidence exercises deployed integration boundaries.
 * AUTH.md §5: authenticated HTML uses the same bearer session gate as JSON.
 * MVP_REFERENCE.md §5/§10: public, veteran, responder, and admin surfaces remain
 * truthful and structurally usable in a browser.
 *
 * Public checks need no secrets. Authenticated checks run only when an operator
 * supplies fresh gitignored synthetic seed credentials through environment
 * variables or GitHub Actions secrets. Credentials are never printed.
 */

import { expect, test, type Browser, type Page } from '@playwright/test';

function optionalCredential(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === '' ? undefined : value;
}

const veteranBearer = optionalCredential('SUAS_E2E_VETERAN_BEARER');
const responderBearer = optionalCredential('SUAS_E2E_RESPONDER_BEARER');
const adminBearer = optionalCredential('SUAS_E2E_ADMIN_BEARER');

async function authenticatedPage(browser: Browser, credential: string): Promise<Page> {
  const context = await browser.newContext({
    extraHTTPHeaders: { authorization: `Bearer ${credential}` },
  });
  return context.newPage();
}

async function expectHtmlSurface(page: Page, path: string): Promise<void> {
  const response = await page.goto(path, { waitUntil: 'domcontentloaded' });
  expect(response, `${path} returned no response`).not.toBeNull();
  expect(response?.status(), `${path} did not return HTTP 200`).toBe(200);
  expect(response?.headers()['content-type']).toContain('text/html');
  await expect(page.locator('main')).toHaveCount(1);
  await expect(page.locator('h1')).toHaveCount(1);
}

async function expectNoHorizontalOverflow(page: Page, path: string): Promise<void> {
  await page.setViewportSize({ width: 320, height: 800 });
  await expectHtmlSurface(page, path);
  await expect
    .poll(
      async () =>
        page.evaluate<boolean>(
          'document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1',
        ),
      { message: `${path} overflows at 320 CSS px` },
    )
    .toBe(true);
}

async function expectKeyboardEntry(page: Page, path: string): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await expectHtmlSurface(page, path);
  const skipLink = page.getByRole('link', { name: 'Skip to main content' });
  await page.keyboard.press('Tab');
  await expect(skipLink).toBeFocused();
  await expect(skipLink).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#main$/);
}

test.describe('deployed public boundary', () => {
  test('@public health exposes durable synthetic-STAGING dependencies', async ({ request }) => {
    const response = await request.get('/api/v0/health');
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'ok',
      dependencies: {
        database: { status: 'configured' },
        job_queue: {
          status: 'configured',
          durability: 'durable',
          implementation: 'postgres-outbox',
        },
      },
    });
  });

  test('@public landing and enrollment render in Chromium', async ({ page }) => {
    await expectHtmlSurface(page, '/app');
    await expect(page).toHaveTitle(/Shut Up and Serve/i);
    await expect(page.getByText('Veteran peer support', { exact: false })).toBeVisible();

    await expectHtmlSurface(page, '/app/join');
    await expect(page.getByText('sign-in code', { exact: false })).toBeVisible();
  });

  test('@public protected HTML fails closed without a session', async ({ page }) => {
    const response = await page.goto('/app/home');
    expect(response?.status()).toBe(401);
    expect(await response?.json()).toMatchObject({
      error: { code: 'UNAUTHENTICATED' },
    });
  });

  test('@public keyboard entry and 320px reflow work in Chromium', async ({ page }) => {
    await expectKeyboardEntry(page, '/app');
    await expectNoHorizontalOverflow(page, '/app');
    await expectNoHorizontalOverflow(page, '/app/join');
  });
});

test.describe('deployed authenticated synthetic surfaces', () => {
  test('veteran routes render with an operator-supplied synthetic session', async ({ browser }) => {
    test.skip(veteranBearer === undefined, 'SUAS_E2E_VETERAN_BEARER is not configured.');
    const page = await authenticatedPage(browser, veteranBearer ?? '');
    for (const path of [
      '/app/home',
      '/app/notifications',
      '/app/notifications/preferences',
      '/app/consents',
      '/app/trusted-contacts',
      '/app/resources',
      '/app/resources/food',
      '/app/immediate-resources',
    ]) {
      await expectHtmlSurface(page, path);
      await expectNoHorizontalOverflow(page, path);
    }
    await expectKeyboardEntry(page, '/app/home');
  });

  test('responder routes render with an operator-supplied synthetic session', async ({
    browser,
  }) => {
    test.skip(responderBearer === undefined, 'SUAS_E2E_RESPONDER_BEARER is not configured.');
    const page = await authenticatedPage(browser, responderBearer ?? '');
    for (const path of ['/app/responder', '/app/responder/availability']) {
      await expectHtmlSurface(page, path);
      await expectNoHorizontalOverflow(page, path);
    }
    await expectHtmlSurface(page, '/app/responder');
    const casePath = await page
      .locator('a[href^="/app/responder/cases/"]')
      .first()
      .getAttribute('href');
    expect(casePath, 'Seeded responder dashboard has no case link.').not.toBeNull();
    await expectNoHorizontalOverflow(page, casePath ?? '');
    await expectKeyboardEntry(page, '/app/responder');
  });

  test('admin route renders only with an operator-supplied elevated session', async ({
    browser,
  }) => {
    test.skip(adminBearer === undefined, 'SUAS_E2E_ADMIN_BEARER is not configured.');
    const page = await authenticatedPage(browser, adminBearer ?? '');
    await expectHtmlSurface(page, '/app/admin');
    await expectNoHorizontalOverflow(page, '/app/admin');
    await expectKeyboardEntry(page, '/app/admin');
  });
});
