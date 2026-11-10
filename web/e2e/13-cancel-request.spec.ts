import { expect, test } from '@playwright/test';
import { newPerson, newVerifiedVeteran, requestHelp, signUp, uniqueEmail } from './helpers';

test('a Veteran cancels a sent request and it leaves the open list for helpers', async ({
  browser,
  request,
}) => {
  const requester = await newVerifiedVeteran(browser, request, {
    name: 'Lee C.',
    county: 'Alameda',
    label: 'canceller',
  });
  const summary = `Ride to the VA clinic ${uniqueEmail('c').slice(6, 14)}`;
  await requestHelp(
    requester.page,
    request,
    { category: 'TRANSPORTATION', summary, timing: 'Friday at noon' },
    'Bus stop on Main Street',
  );

  // A helper in the same county is offered the request while it is open.
  const helper = await newPerson(browser);
  await signUp(helper, request, {
    email: uniqueEmail('cancel-helper'),
    name: 'Sam H.',
    county: 'Alameda',
    role: 'serve',
  });
  const open = helper.getByRole('region', { name: 'Open requests' });
  await expect(open).toContainText(summary);

  // Cancel asks first, with "Keep request active" focused so a stray Enter keeps it.
  const page = requester.page;
  await page.getByRole('button', { name: 'Cancel request' }).click();
  const dialog = page.getByRole('dialog', { name: 'Cancel this request?' });
  await expect(dialog.getByRole('button', { name: 'Keep request active' })).toBeFocused();
  await dialog.getByRole('button', { name: 'Cancel request' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: 'Cancelled' })).toBeVisible();
  await expect(page.getByText('Request cancelled.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel request' })).toHaveCount(0);

  // Home lists it as cancelled.
  await page.getByRole('link', { name: /back to home/i }).click();
  await expect(
    page
      .getByRole('region', { name: 'Your requests' })
      .getByRole('link', { name: new RegExp(summary) }),
  ).toContainText('Cancelled');

  // The helper's open list no longer offers it.
  await helper.reload();
  await expect(open.getByText('Loading open requests…')).toHaveCount(0);
  await expect(open.getByRole('heading', { name: 'Open requests' })).toBeVisible();
  await expect(open).not.toContainText(summary);
});
