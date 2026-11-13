import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { expectCrisisScreen, passIdCheck, requestHelp, signUp, uniqueEmail } from './helpers';

/** WCAG 1.4.10 Reflow: content fits 320 CSS px without scrolling sideways (R9.7 planned check). */
const NARROW = { width: 320, height: 640 };
test.use({ viewport: NARROW, isMobile: true, hasTouch: true });

async function expectReflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    NARROW.width,
  );
}

test('at 320 px the signed-out crisis screen reflows', async ({ page }) => {
  await page.goto('/crisis');
  await expectCrisisScreen(page);
  await expectReflow(page);
});

test('at 320 px the request flow reflows from sign-up to a sent request', async ({
  page,
  request,
}) => {
  await signUp(page, request, { email: uniqueEmail('reflow'), name: 'Ana P.', county: 'Merced' });
  await expectReflow(page);
  await passIdCheck(page);
  await expectReflow(page);
  await page.getByRole('link', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/home$/);
  await expectReflow(page);
  await page.goto('/request');
  await expectReflow(page);
  await requestHelp(
    page,
    request,
    { category: 'FOOD', summary: `Groceries ${uniqueEmail('x').slice(6, 14)}`, timing: 'Tomorrow' },
    'Front entrance of the library',
  );
  await expect(page.getByRole('status').filter({ hasText: 'Request received' })).toBeVisible();
  await expectReflow(page);
});
