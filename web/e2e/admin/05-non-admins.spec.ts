import { expect, test } from '../fixtures';
import type { Page } from '@playwright/test';
import { newPerson, shoot, signUp, uniqueEmail } from '../helpers';
import { elevatedAdmin, openNewDraft, uniqueName } from './admin';

/**
 * Records, from the first paint, whether any admin chrome or admin heading ever appeared, so a
 * redirect that briefly shows admin UI is caught, not only the final screen.
 */
async function watchForAdminFlash(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __adminSeen: string[] };
    w.__adminSeen = [];
    const check = () => {
      if (document.querySelector('nav[aria-label="SUAS Admin sections"]'))
        w.__adminSeen.push(`admin nav on ${location.pathname}`);
      const h1 = document.querySelector('h1')?.textContent ?? '';
      if (/^(Overview|Resource drafts?|Confirm it is you)$/.test(h1.trim()))
        w.__adminSeen.push(`h1 "${h1}" on ${location.pathname}`);
    };
    new MutationObserver(check).observe(document, { childList: true, subtree: true });
  });
}

const adminSeen = (page: Page) =>
  page.evaluate(() => (window as unknown as { __adminSeen: string[] }).__adminSeen);

test('a Veteran and a helper deep-linking to any admin address are sent to /home, with no admin data', async ({
  browser,
  request,
}) => {
  // A real draft id, so the deep link points at something that exists.
  const admin = await elevatedAdmin(browser, request);
  const draftId = await openNewDraft(admin, request, {
    service_name: uniqueName('Private Draft Pantry'),
    category: 'FOOD',
  });
  const targets = ['/admin', '/admin/drafts', `/admin/drafts/${draftId}`, '/admin/mfa'];

  for (const role of ['need', 'serve'] as const) {
    const page = await newPerson(browser);
    await signUp(page, request, {
      email: uniqueEmail(`admin-${role}`),
      name: role === 'need' ? 'Tia N.' : 'Hal S.',
      county: 'Merced',
      role,
    });
    await watchForAdminFlash(page);
    const adminCalls: string[] = [];
    page.on('request', (r) => {
      if (/\/api\/v0\/(admin|auth\/mfa)\//.test(r.url())) adminCalls.push(r.url());
    });
    for (const path of targets) {
      await page.goto(path);
      await expect(page, `${role} on ${path}`).toHaveURL(/\/home$/);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.getByRole('complementary', { name: 'Crisis support' })).toBeVisible();
      expect(await adminSeen(page), `${role} on ${path}`).toEqual([]);
      // The admin address was replaced, so Back does not loop into it.
      await page.goBack();
      await expect(page).not.toHaveURL(/\/admin/);
    }
    expect(adminCalls, `${role}: no admin API calls`).toEqual([]);
    await shoot(page, `admin-05-${role}-bounced`);
  }
});

test('while the account is loading or fails to load on an admin address, the crisis strip is there', async ({
  browser,
  request,
  allow,
}) => {
  // Provoked on purpose: the browser logs each refused load.
  allow.push(/veterans\/me :: 500$/, /status of 500/);
  const page = await newPerson(browser);
  await signUp(page, request, {
    email: uniqueEmail('admin-slow'),
    name: 'Ola B.',
    county: 'Stanislaus',
  });
  await watchForAdminFlash(page);

  // Slow /me (held, not faked): the guard's loading screen shows with the strip.
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/v0/veterans/me', async (route) => {
    await held;
    await route.fallback();
  });
  await page.goto('/admin/drafts');
  await expect(page.getByRole('status')).toHaveText('Loading…');
  const strip = page.getByRole('complementary', { name: 'Crisis support' });
  await expect(strip.getByRole('link', { name: 'Call 911' })).toHaveAttribute('href', 'tel:911');
  await expect(strip.getByRole('link', { name: 'Call 988' })).toHaveAttribute('href', 'tel:988');
  release();
  await expect(page).toHaveURL(/\/home$/);
  await page.unroute('**/api/v0/veterans/me');

  // A 5xx on /me cannot be reached on the real stack, so it is routed until Try again.
  let failing = true;
  await page.route('**/api/v0/veterans/me', (route) =>
    failing ? route.fulfill({ status: 500, body: '{}' }) : route.fallback(),
  );
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'We could not load your account.' })).toBeVisible({
    timeout: 20_000,
  });
  await expect(strip).toBeVisible();
  await shoot(page, 'admin-05-guard-failed');
  failing = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page).toHaveURL(/\/home$/);
  expect(await adminSeen(page)).toEqual([]);
});
