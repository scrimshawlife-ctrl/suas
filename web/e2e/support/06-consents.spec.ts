import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { ALERT_SWITCH, closePeople, contactRow, veteran, veteranWithNotice } from './support';

test.afterEach(closePeople);

function grant(page: Page, label: string) {
  return page.getByRole('listitem').filter({ hasText: `Your trusted contact: ${label}` });
}

test('with nothing shared, What you share shows the empty state', async ({ browser, request }) => {
  const { page } = await veteran(browser, request, { name: 'Oz P.', county: 'Alameda' });
  await page.goto('/consents');
  await expect(page).toHaveTitle('What you share · SUAS');
  await expect(page.getByText('You are not sharing anything right now.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop sharing' })).toHaveCount(0);
});

test('the RED notice is listed as Sharing; Stop sharing asks first, then stops it everywhere', async ({
  browser,
  request,
}) => {
  const { page } = await veteranWithNotice(browser, request, 'Sister');
  await page.getByRole('link', { name: 'What you share' }).click();
  await expect(page).toHaveURL(/\/consents$/);
  await expect(grant(page, 'Sister')).toContainText(
    'Get a notice from SUAS after a Check-In shows you need support right away',
  );
  await expect(grant(page, 'Sister').getByText('Sharing', { exact: true })).toBeVisible();

  const dialog = page.getByRole('dialog', { name: 'Stop sharing?' });
  await grant(page, 'Sister').getByRole('button', { name: 'Stop sharing' }).click();
  await expect(dialog).toContainText('Your trusted contact: Sister');
  await dialog.getByRole('button', { name: 'Keep sharing' }).click();
  await expect(dialog).toBeHidden();
  await expect(grant(page, 'Sister').getByText('Sharing', { exact: true })).toBeVisible();

  await grant(page, 'Sister').getByRole('button', { name: 'Stop sharing' }).click();
  await dialog.getByRole('button', { name: 'Stop sharing' }).click();
  await expect(dialog).toBeHidden();
  await expect(grant(page, 'Sister').getByText('Stopped', { exact: true })).toBeVisible();
  await expect(grant(page, 'Sister')).toContainText(/Stopped [A-Z][a-z]{2} \d{1,2}, \d{4}/);
  await expect(grant(page, 'Sister').getByRole('button', { name: 'Stop sharing' })).toHaveCount(0);

  // Back on Trusted contacts, the switch is off.
  await page.goBack();
  await expect(page).toHaveURL(/\/trusted-contacts$/);
  await expect(
    contactRow(page, 'Sister').getByRole('switch', { name: ALERT_SWITCH }),
  ).not.toBeChecked();
});

test('removing a contact who gets the RED notice leaves nothing Sharing', async ({
  browser,
  request,
}) => {
  const { page } = await veteranWithNotice(browser, request, 'Friend');
  await contactRow(page, 'Friend').getByRole('button', { name: 'Remove' }).click();
  await page
    .getByRole('dialog', { name: 'Remove Friend?' })
    .getByRole('button', { name: 'Remove' })
    .click();
  await expect(page.getByText('You have not added anyone yet.')).toBeVisible();

  await page.goto('/consents');
  await expect(page.getByRole('listitem').first()).toBeVisible();
  await expect(page.getByText('Sharing', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Stop sharing' })).toHaveCount(0);
});
