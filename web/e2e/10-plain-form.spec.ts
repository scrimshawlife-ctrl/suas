import { expect, test } from './fixtures';
import { newVerifiedVeteran, shoot, uniqueEmail } from './helpers';

test('a Veteran sends a request through the plain form shown under the Intake Assistant', async ({
  browser,
  request,
}) => {
  const { page } = await newVerifiedVeteran(browser, request, {
    name: 'Marcus T.',
    county: 'Santa Clara',
    label: 'plain-form',
  });
  const summary = `Someone to talk to this week ${uniqueEmail('p').slice(6, 14)}`;

  // R5.15: the assistant and the plain form are both on the page, with no toggle between them.
  await page.goto('/request');
  await expect(page.getByLabel('Tell us what you need')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Or fill in the form' })).toBeVisible();
  await expect(page.getByRole('button', { name: /instead/ })).toHaveCount(0);

  const form = page.getByRole('form', { name: 'Request form' });
  await form.getByLabel('What kind of help do you need?').selectOption('PEER_SUPPORT');
  await form.getByLabel('Short summary').fill(summary);
  await form.getByRole('button', { name: 'Send request' }).click();

  await expect(page).toHaveURL(/\/requests\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('status').filter({ hasText: 'Request received' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'What you sent' })).toContainText(summary);
  await shoot(page, '10-plain-form-sent');
});
