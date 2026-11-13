import { expect, test } from '../fixtures';
import { newPerson, signInWithCode, uniqueEmail } from '../helpers';
import { closePeople, contactRow, invite, veteran } from './support';

test.afterEach(closePeople);

test('an invitee with no profile yet sees each invitation, accepts them one by one, then has none', async ({
  browser,
  request,
}) => {
  const email = uniqueEmail('invitee');
  const first = await veteran(browser, request, { name: 'Marcus T.', county: 'Santa Clara' });
  await first.page.goto('/trusted-contacts');
  await invite(first.page, 'Sister', email);
  const second = await veteran(browser, request, { name: 'Lee M.', county: 'Alameda' });
  await second.page.goto('/trusted-contacts');
  await invite(second.page, 'Battle buddy', email);

  // Signed in is enough for /invitations: the invitee has not finished the profile.
  const invitee = await newPerson(browser);
  await signInWithCode(invitee, request, email);
  await expect(invitee).toHaveURL(/\/welcome$/);
  await invitee.goto('/invitations');
  await expect(invitee).toHaveTitle('Invitations · SUAS');
  const items = invitee.getByRole('listitem');
  await expect(items).toHaveCount(2);
  await expect(items.filter({ hasText: 'Marcus T.' })).toContainText('They listed you as: Sister');
  await expect(items.filter({ hasText: 'Lee M.' })).toContainText(
    'They listed you as: Battle buddy',
  );

  await invitee.getByRole('button', { name: 'Accept the invitation from Marcus T.' }).click();
  await expect(
    invitee.getByText('Accepted. They can now choose what SUAS may tell you.'),
  ).toBeVisible();
  await expect(items).toHaveCount(1);
  await expect(items).toContainText('Lee M.');

  // Only the Veteran whose invitation was accepted sees Accepted.
  await first.page.reload();
  await expect(contactRow(first.page, 'Sister').getByText('Accepted')).toBeVisible();
  await second.page.reload();
  await expect(contactRow(second.page, 'Battle buddy').getByText('Invited')).toBeVisible();

  await invitee.getByRole('button', { name: 'Accept the invitation from Lee M.' }).click();
  await expect(invitee.getByText('You have no invitations.')).toBeVisible();
  await invitee.reload();
  await expect(invitee.getByText('You have no invitations.')).toBeVisible();
  await invitee.context().close();
});
