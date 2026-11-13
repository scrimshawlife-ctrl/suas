import { expect, test } from '../fixtures';
import { uniqueEmail } from '../helpers';
import { closePeople, contactRow, invite, serverError, veteran } from './support';

test.afterEach(closePeople);

test('adding a trusted contact: validation, success, the list, and Remove after Keep and Escape', async ({
  browser,
  request,
}) => {
  const { page } = await veteran(browser, request, { name: 'Marcus T.', county: 'Santa Clara' });
  await page.goto('/trusted-contacts');
  await expect(page).toHaveTitle('Trusted contacts · SUAS');
  await expect(page.getByText('You have not added anyone yet.')).toBeVisible();

  // Empty and invalid input: plain errors, focus on the first, nothing added.
  const add = page.getByRole('button', { name: 'Add trusted contact' });
  await add.click();
  await expect(page.getByText('Enter who this person is to you.')).toBeVisible();
  await expect(page.getByText('Enter a full email address.')).toBeVisible();
  await expect(page.getByLabel('Who is this to you?')).toBeFocused();
  await page.getByLabel('Who is this to you?').fill('   ');
  await page.getByLabel('Their email').fill('not-an-email');
  await add.click();
  await expect(page.getByText('Enter a full email address.')).toBeVisible();
  await expect(page.getByText('You have not added anyone yet.')).toBeVisible();

  await invite(page, 'Sister', uniqueEmail('sister'));
  await expect(contactRow(page, 'Sister').getByText('Invited')).toBeVisible();
  await expect(
    contactRow(page, 'Sister').getByText(
      'You can choose whether to alert this person once they have accepted.',
    ),
  ).toBeVisible();
  await expect(page.getByLabel('Who is this to you?')).toHaveValue('');
  await page.reload();
  await expect(contactRow(page, 'Sister')).toHaveCount(1);

  // Remove asks first; Keep and Escape leave the contact.
  const dialog = page.getByRole('dialog', { name: 'Remove Sister?' });
  await contactRow(page, 'Sister').getByRole('button', { name: 'Remove' }).click();
  await dialog.getByRole('button', { name: 'Keep' }).click();
  await expect(dialog).toBeHidden();
  await contactRow(page, 'Sister').getByRole('button', { name: 'Remove' }).click();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(contactRow(page, 'Sister')).toHaveCount(1);

  await contactRow(page, 'Sister').getByRole('button', { name: 'Remove' }).click();
  await dialog.getByRole('button', { name: 'Remove' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('You have not added anyone yet.')).toBeVisible();
  await page.reload();
  await expect(page.getByText('You have not added anyone yet.')).toBeVisible();
});

test('a second invite to the same address returns the first one, and the 11th new invite is refused', async ({
  browser,
  request,
  allow,
}) => {
  // The 11th invite is refused on purpose.
  allow.push(/status of 429/);
  const { page } = await veteran(browser, request, { name: 'Gus A.', county: 'Santa Clara' });
  await page.goto('/trusted-contacts');

  // R9.4: the API answers 200 with the open invite; the list still has one row.
  const buddy = uniqueEmail('buddy');
  expect(await invite(page, 'Battle buddy', buddy)).toBe(201);
  expect(await invite(page, 'Battle buddy', buddy)).toBe(200);
  await expect(contactRow(page, 'Battle buddy')).toHaveCount(1);

  // Ten new invites per Veteran per 24 hours (INVITE_LIMIT_PER_VETERAN); the duplicate was free.
  for (let n = 2; n <= 10; n += 1) await invite(page, `Friend ${String(n)}`, uniqueEmail('friend'));
  const refused = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith('/api/v0/trusted-contacts'),
  );
  await page.getByLabel('Who is this to you?').fill('Friend 11');
  await page.getByLabel('Their email').fill(uniqueEmail('friend'));
  await page.getByRole('button', { name: 'Add trusted contact' }).click();
  expect((await refused).status()).toBe(429);
  await expect(page.getByRole('alert')).toContainText('too many tries');
  // What was typed stays, and nothing was added.
  await expect(page.getByLabel('Who is this to you?')).toHaveValue('Friend 11');
  await expect(contactRow(page, 'Friend 11')).toHaveCount(0);
  await expect(
    page.getByRole('region', { name: 'Your trusted contacts' }).getByRole('listitem'),
  ).toHaveCount(10);
});

test('when adding a contact fails on the server, the form says so and keeps what was typed', async ({
  browser,
  request,
  allow,
}) => {
  // The 500 is the one this test returns on purpose.
  // Only the routed add may 500; a real backend 500 still fails the test.
  allow.push(/POST \S+\/api\/v0\/trusted-contacts :: 500$/, /status of 500/);
  const { page } = await veteran(browser, request, { name: 'Tess Q.', county: 'Alameda' });
  await page.goto('/trusted-contacts');
  await page.route('**/api/v0/trusted-contacts', (route) =>
    route.request().method() === 'POST' ? route.fulfill(serverError()) : route.fallback(),
  );
  await page.getByLabel('Who is this to you?').fill('Cousin');
  await page.getByLabel('Their email').fill(uniqueEmail('cousin'));
  await page.getByRole('button', { name: 'Add trusted contact' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Something went wrong on our side. Try to add this person again.',
  );
  await expect(page.getByLabel('Who is this to you?')).toHaveValue('Cousin');
  await page.unroute('**/api/v0/trusted-contacts');
  await page.getByRole('button', { name: 'Add trusted contact' }).click();
  await expect(page.getByText('Added. They are listed below.')).toBeVisible();
  await expect(contactRow(page, 'Cousin')).toHaveCount(1);
});
