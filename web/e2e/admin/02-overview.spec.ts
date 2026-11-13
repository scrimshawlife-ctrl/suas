import { expect, test } from '../fixtures';
import { API_URL } from '../config';
import { shoot } from '../helpers';
import { LANDING, expectNoDeadControls } from '../auth/auth';
import { elevatedAdmin } from './admin';

const SOON = ['Access', 'Published artifacts', 'Platform operations', 'Audit explorer'];
const CRISIS_COPY: Record<string, string> = {
  approved: 'Approved copy on',
  placeholder_test_only: 'Test copy',
};

test('the overview shows what this build reports, and every sidebar control goes somewhere real', async ({
  browser,
  request,
}) => {
  const page = await elevatedAdmin(browser, request);
  await expect(page).toHaveTitle('Overview · SUAS Admin');
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
  await expect(page.getByText('Scope: Local synthetic data.')).toBeVisible();

  // Capabilities: rows match what build-info reports for this stack.
  const token = await page.evaluate(() => sessionStorage.getItem('suas.session'));
  const headers = { authorization: `Bearer ${token ?? ''}` };
  const info = (await (
    await request.get(`${API_URL}/api/v0/admin/build-info`, { headers })
  ).json()) as { capabilities: Record<string, unknown>; production_readiness?: string };
  const caps = page.getByRole('region', { name: 'Capabilities' });
  await expect(caps).toBeVisible();
  const crisisCopy = CRISIS_COPY[String(info.capabilities['safety_copy_mode'])];
  expect(crisisCopy, 'the e2e stack runs approved or test crisis copy').toBeTruthy();
  await expect(caps.getByRole('definition').filter({ hasText: crisisCopy ?? '' })).toBeVisible();
  await expect(caps.getByText('Email sign-in')).toBeVisible();
  await expect(caps.getByText('Support Signal scoring')).toBeVisible();
  if (typeof info.production_readiness === 'string') {
    await expect(page.getByText(/^Production readiness: /)).toHaveText(
      `Production readiness: ${info.production_readiness.toLowerCase().replaceAll('_', ' ')}`,
    );
  }

  // Provider adapters: one card per catalog entry, no more, no fewer.
  const catalog = (await (
    await request.get(`${API_URL}/api/v0/admin/adapter-catalog`, { headers })
  ).json()) as { adapters: { label: string }[] };
  const adapters = page.getByRole('region', { name: 'Provider adapters' });
  await expect(adapters.getByRole('listitem')).toHaveCount(catalog.adapters.length);
  for (const adapter of catalog.adapters) {
    await expect(adapters.getByRole('heading', { name: adapter.label }).first()).toBeVisible();
  }
  await expect(page.getByRole('region', { name: 'Readiness' })).toContainText(
    info.capabilities['allow_real_external_effects'] === false
      ? 'Real-world effects are disabled.'
      : 'SPEC-018',
  );
  await expectNoDeadControls(page);
  await shoot(page, 'admin-02-overview');

  // Sidebar: the live sections are links; the "Not yet" ones are plainly not.
  const nav = page.getByRole('navigation', { name: 'SUAS Admin sections' });
  await expect(nav.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
  for (const label of SOON) {
    await expect(nav.getByRole('link', { name: label })).toHaveCount(0);
    const item = nav.locator('[aria-disabled="true"]', { hasText: label });
    await expect(item).toContainText('Not yet');
    await item.click();
    await expect(page).toHaveURL(/\/admin$/);
  }

  await nav.getByRole('link', { name: 'Resource drafts' }).click();
  await expect(page).toHaveURL(/\/admin\/drafts$/);
  await expect(nav.getByRole('link', { name: 'Resource drafts' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page).toHaveTitle('Resource drafts · SUAS Admin');
  await page.getByRole('link', { name: 'SUAS Admin home' }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/admin\/drafts$/);
  await page.goForward();
  await expect(page).toHaveURL(/\/admin$/);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();

  // The skip link reaches the main content.
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: /skip/i })).toBeFocused();
});

test('when build info or the adapter list fails to load, the overview says so and Try again recovers', async ({
  browser,
  request,
  allow,
}) => {
  // Provoked on purpose: the browser logs each refused load.
  allow.push(/admin\/(build-info|adapter-catalog) :: 500$/, /status of 500/);
  const page = await elevatedAdmin(browser, request);
  // A 5xx cannot be reached on the real stack, so it is routed until the retry.
  let failing = true;
  for (const path of ['**/api/v0/admin/build-info', '**/api/v0/admin/adapter-catalog']) {
    await page.route(path, (route) =>
      failing ? route.fulfill({ status: 500, body: '{}' }) : route.fallback(),
    );
  }
  await page.reload();
  const caps = page.getByRole('region', { name: 'Capabilities' });
  await expect(caps.getByText('We could not load capabilities.')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('We could not load provider adapters.')).toBeVisible({
    timeout: 20_000,
  });
  await shoot(page, 'admin-02-overview-failed');
  failing = false;
  await caps.getByRole('button', { name: 'Try again' }).click();
  await expect(caps.getByText('Crisis copy')).toBeVisible();
  const adapters = page.getByRole('region', { name: 'Provider adapters' });
  await adapters.getByRole('button', { name: 'Try again' }).click();
  await expect(adapters.getByRole('listitem').first()).toBeVisible();
});

test('signing out from the console ends on the landing page, and Back shows no admin data', async ({
  browser,
  request,
}) => {
  const page = await elevatedAdmin(browser, request);
  await page.getByRole('link', { name: 'Resource drafts' }).click();
  await expect(page).toHaveURL(/\/admin\/drafts$/);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(LANDING);
  expect(await page.evaluate(() => sessionStorage.getItem('suas.session'))).toBeNull();
  expect(await page.evaluate(() => sessionStorage.getItem('suas.mfa'))).toBeNull();
  await page.goBack();
  await expect(page).not.toHaveURL(/\/admin/);
  await expect(page.getByRole('heading', { name: 'Resource drafts' })).toHaveCount(0);
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/sign-in$/);
});
