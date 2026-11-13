import { expect, test } from '../fixtures';
import { requestHelp, uniqueEmail } from '../helpers';
import {
  closePeople,
  contactRow,
  invite,
  questionHeading,
  startCheckIn,
  uniqueSummary,
  veteran,
} from '../support/support';

test.afterEach(closePeople);

test('a Check-In resumes after refresh, after Back and Forward, and after leaving by the header', async ({
  browser,
  request,
}) => {
  const { page } = await veteran(browser, request, { name: 'Bo N.', county: 'Alameda' });
  await startCheckIn(page);
  for (const next of [2, 3]) {
    await page.getByRole('radio').first().check();
    await page.getByRole('button', { name: 'Save answer' }).click();
    await expect(page.getByText(`Question ${String(next)} of 9`)).toBeVisible();
  }

  await page.reload();
  await expect(page.getByText('Question 3 of 9')).toBeVisible();
  await expect(questionHeading(page)).toContainText('stress');

  await page.goBack();
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.getByRole('link', { name: 'Continue Check-In' })).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(/\/check-in$/);
  await expect(page.getByText('Question 3 of 9')).toBeVisible();

  await page.getByRole('banner').getByRole('link', { name: 'Home', exact: true }).click();
  await expect(page).toHaveURL(/\/home$/);
  await page.getByRole('link', { name: 'Continue Check-In' }).click();
  await expect(page.getByText('Question 3 of 9')).toBeVisible();
});

test('after sending a request, Back, Forward and refresh never send it twice', async ({
  browser,
  request,
}) => {
  const { page } = await veteran(browser, request, { name: 'Marcus T.', county: 'Santa Clara' });
  const summary = uniqueSummary('Groceries');
  const requestId = await requestHelp(
    page,
    request,
    { category: 'FOOD', summary },
    'Front entrance of the library',
  );
  await page.reload();
  await expect(page).toHaveURL(new RegExp(`/requests/${requestId}$`));
  await expect(page.getByText('Your request has been received.')).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/\/request$/);
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`/requests/${requestId}$`));
  await expect(page.getByText('Your request has been received.')).toBeVisible();

  await page.goto('/requests');
  await expect(page.getByRole('link', { name: new RegExp(summary) })).toHaveCount(1);
});

test('after removing a trusted contact, Back and Forward do not bring it back', async ({
  browser,
  request,
}) => {
  const { page } = await veteran(browser, request, { name: 'Nia S.', county: 'Santa Clara' });
  await page.goto('/consents');
  await page.goto('/trusted-contacts');
  await invite(page, 'Friend', uniqueEmail('friend'));
  await contactRow(page, 'Friend').getByRole('button', { name: 'Remove' }).click();
  await page
    .getByRole('dialog', { name: 'Remove Friend?' })
    .getByRole('button', { name: 'Remove' })
    .click();
  await expect(page.getByText('You have not added anyone yet.')).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/\/consents$/);
  await page.goForward();
  await expect(page).toHaveURL(/\/trusted-contacts$/);
  await expect(page.getByText('You have not added anyone yet.')).toBeVisible();
});
