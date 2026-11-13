import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { expectCrisisScreen, passIdCheck, requestHelp, signUp, uniqueEmail } from './helpers';

const PHONE = { width: 390, height: 844 };
test.use({ viewport: PHONE, isMobile: true, hasTouch: true });

/** Nothing on the page is wider than the phone screen. */
async function expectNoSideways(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    PHONE.width,
  );
}

/**
 * Below 640 px the header's Primary nav is hidden and the fixed bottom tab bar (Home, Chat)
 * takes its place, so the one visible Primary nav must sit on the bottom edge of the screen.
 */
async function bottomTabBar(page: Page) {
  const tabs = page.getByRole('navigation', { name: 'Primary' });
  await expect(tabs).toHaveCount(1);
  await expect(tabs.getByRole('link', { name: 'Home' })).toBeVisible();
  await expect(tabs.getByRole('link', { name: 'Chat' })).toBeVisible();
  const box = await tabs.boundingBox();
  expect(box && Math.round(box.y + box.height)).toBe(PHONE.height);
  return tabs;
}

test('on a phone, a Veteran signs up, passes the ID check and sends a request', async ({
  page,
  request,
}) => {
  await signUp(page, request, { email: uniqueEmail('phone'), name: 'Ana P.', county: 'Merced' });
  // Signed in, the phone layout shows the full-width mode switch and the tab bar.
  await expect(page.getByRole('navigation', { name: 'Mode' })).toBeVisible();
  await expect((await bottomTabBar(page)).getByRole('link', { name: 'Home' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expectNoSideways(page);

  await passIdCheck(page);
  // Continue with no return path goes to Request help (VA_CONFIRMATION_FLOW W2 step 6).
  await page.getByRole('link', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/request$/);

  const summary = `Groceries for the week ${uniqueEmail('x').slice(6, 14)}`;
  await requestHelp(
    page,
    request,
    { category: 'FOOD', summary, timing: 'Tomorrow morning' },
    'Front entrance of the library',
  );
  await expect(page.getByRole('status').filter({ hasText: 'Request received' })).toBeVisible();
  await expectNoSideways(page);

  // The tab bar's Home goes back to the list, which now holds the request.
  await (await bottomTabBar(page)).getByRole('link', { name: 'Home' }).click();
  await expect(page).toHaveURL(/\/home$/);
  await expect(
    page
      .getByRole('region', { name: 'Your requests' })
      .getByRole('link', { name: new RegExp(summary) }),
  ).toContainText('Received');
});

test('on a phone, the crisis screen opens signed out with no tab bar', async ({ page }) => {
  await page.goto('/crisis');
  await expectCrisisScreen(page);
  // Signed out there is no signed-in chrome: no tab bar, no mode switch.
  await expect(page.getByRole('navigation', { name: 'Primary' })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Mode' })).toHaveCount(0);
  await expectNoSideways(page);
});
