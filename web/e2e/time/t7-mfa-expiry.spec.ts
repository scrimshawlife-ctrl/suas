import { expect, test } from '../fixtures';
import { closePeople, elevatedAdmin, myUserId, passMfa } from '../support/support';
import { ageElevation } from './time';

test.afterEach(closePeople);

test('T7: an admin action after the 15-minute MFA elevation is refused and goes back to the step-up', async ({
  browser,
  request,
  allow,
}) => {
  // The stale elevation is refused on purpose.
  allow.push(/status of 403/);
  const page = await elevatedAdmin(browser, request);
  // The list has loaded before the elevation ages, so the save is what gets the 403.
  const listed = page.waitForResponse(
    (r) => r.request().method() === 'GET' && r.url().includes('/api/v0/admin/consent-templates'),
  );
  await page.goto('/admin/consent-templates');
  await listed;
  await expect(page.getByRole('heading', { level: 1, name: 'Consent templates' })).toBeVisible();
  await ageElevation(await myUserId(page, request));

  // The client still thinks it is elevated; the server's 403 MFA_REQUIRED corrects it.
  const saved = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().includes('/consent-templates'),
  );
  await page.getByLabel(/Template key/).fill('e2e-t7-elevation');
  await page.getByLabel(/Template text/).fill('Synthetic test template for the e2e suite.');
  await page.getByRole('button', { name: 'Save as draft' }).click();
  const refused = await saved;
  expect(refused.status()).toBe(403);
  expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('MFA_REQUIRED');
  await expect(page).toHaveURL(/\/admin\/mfa$/);

  // A fresh step-up returns to the page the admin was on.
  await passMfa(page);
  await expect(page).toHaveURL(/\/admin\/consent-templates$/);
});
