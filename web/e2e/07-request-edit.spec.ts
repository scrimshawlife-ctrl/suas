import { expect, test } from '@playwright/test';
import { newPerson, newVerifiedVeteran, shoot, signUp, uniqueEmail } from './helpers';

test('a Veteran edits a ride request before anyone accepts and the helper sees the edited text', async ({
  browser,
  request,
}) => {
  const requester = await newVerifiedVeteran(browser, request, {
    name: 'Marcus T.',
    county: 'Santa Clara',
    label: 'editor',
  });
  const page = requester.page;
  const tag = uniqueEmail('r').slice(6, 14);
  const original = `Ride to the clinic ${tag}`;
  const edited = `Ride to the clinic and back ${tag}`;

  // The plain form: the destination field appears once the kind of help is a ride.
  await page.goto('/request?category=TRANSPORTATION');
  const form = page.getByRole('form', { name: 'Request form' });
  await form.getByLabel('Short summary').fill(original);
  await form.getByLabel('Where should the helper meet you?').fill('Front entrance of the library');
  await form.getByLabel(/Where are you going/).fill('Clinic on Main Street');
  await form.getByRole('button', { name: 'Send request' }).click();
  await expect(page).toHaveURL(/\/requests\/[0-9a-f-]{36}$/);
  const requestId = page.url().split('/').pop() ?? '';

  const sent = page.getByRole('region', { name: 'What you sent' });
  await expect(sent).toContainText(original);
  await expect(sent).toContainText('Going to');
  await expect(sent).toContainText('Clinic on Main Street');

  // Edit before accept: the kind of help is fixed, the other fields change in place.
  await sent.getByRole('button', { name: 'Edit request' }).click();
  await expect(sent.getByLabel('What kind of help do you need?')).toBeDisabled();
  await sent.getByLabel('Short summary').fill(edited);
  await sent.getByLabel(/Where are you going/).fill('Clinic on Main Street, back by noon');
  await sent.getByRole('button', { name: 'Save changes' }).click();
  await expect(sent).toContainText(edited);
  await expect(sent).toContainText('Clinic on Main Street, back by noon');
  await expect(sent.getByRole('button', { name: 'Edit request' })).toBeVisible();
  await shoot(page, '07-request-edited');

  // A helper takes it and reads the edited summary and the destination.
  const helper = await newPerson(browser);
  await signUp(helper, request, {
    email: uniqueEmail('helper'),
    name: 'Dee R.',
    county: 'Santa Clara',
    role: 'serve',
  });
  const open = helper.getByRole('region', { name: 'Open requests' });
  await expect(open).toContainText(edited);
  await expect(open).not.toContainText('Clinic on Main Street');
  await helper.getByRole('button', { name: new RegExp(`Take this request: .*${edited}`) }).click();
  await expect(helper).toHaveURL(new RegExp(`/serve/requests/${requestId}$`));
  const needed = helper.getByRole('region', { name: "What's needed" });
  await expect(needed).toContainText(edited);
  await expect(needed).toContainText('Going to');
  await expect(needed).toContainText('Clinic on Main Street, back by noon');
  await shoot(helper, '07-case-going-to');

  // Once accepted the request is locked: the requester loses the Edit action.
  await page.reload();
  await expect(page.getByText('Dee R. accepted your request.')).toBeVisible();
  await expect(
    page
      .getByRole('region', { name: 'What you sent' })
      .getByRole('button', { name: 'Edit request' }),
  ).toHaveCount(0);
});
