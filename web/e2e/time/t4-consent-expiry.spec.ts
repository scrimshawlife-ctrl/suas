import { expect, test } from '../fixtures';
import { runJobWorkerOnce } from '../helpers';
import {
  ALERT_SWITCH,
  closePeople,
  contactRow,
  myUserId,
  veteranWithNotice,
} from '../support/support';
import { expireGrants } from './time';

test.afterEach(closePeople);

test('T4: when the RED notice grant expires, the sweep turns the switch off and What you share says Expired', async ({
  browser,
  request,
}) => {
  const { page } = await veteranWithNotice(browser, request, 'Sister');
  await expireGrants(await myUserId(page, request));
  expect(runJobWorkerOnce()).toContain('"msg":"consent_grants_expired"');

  await page.reload();
  const toggle = contactRow(page, 'Sister').getByRole('switch', { name: ALERT_SWITCH });
  await expect(toggle).not.toBeChecked();
  await expect(
    contactRow(page, 'Sister').getByText('Off. This person will not get a notice.'),
  ).toBeVisible();

  await page.goto('/consents');
  const grant = page.getByRole('listitem').filter({ hasText: 'Your trusted contact: Sister' });
  await expect(grant.getByText('Expired', { exact: true })).toBeVisible();
  await expect(grant.getByRole('button', { name: 'Stop sharing' })).toHaveCount(0);

  // Turning it on again makes a new grant; the expired one stays listed.
  await page.goBack();
  await toggle.click();
  await expect(toggle).toBeChecked();
  await page.goto('/consents');
  await expect(grant.getByText('Sharing', { exact: true })).toHaveCount(1);
  await expect(grant.getByText('Expired', { exact: true })).toHaveCount(1);
});
