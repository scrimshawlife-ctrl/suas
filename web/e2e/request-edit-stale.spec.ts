import { expect, test } from './fixtures';
import { newPerson, newVerifiedVeteran, signUp, uniqueEmail } from './helpers';

// G20: the edit carries the status the form loaded, so an accept that lands while the
// requester is editing is refused (409 STALE_STATE) and the requester is told why.
test('a helper accepts while the requester edits: the edit is refused with a plain reason', async ({
  browser,
  request,
  allow,
}) => {
  // Provoked on purpose: the stale edit is refused.
  allow.push(/status of 409/);
  const requester = await newVerifiedVeteran(browser, request, {
    name: 'Rosa M.',
    county: 'San Benito',
    label: 'stale-editor',
  });
  const page = requester.page;
  const tag = uniqueEmail('r').slice(6, 14);
  const original = `Ride to the pharmacy ${tag}`;

  await page.goto('/request?category=TRANSPORTATION');
  const form = page.getByRole('form', { name: 'Request form' });
  await form.getByLabel('Short summary').fill(original);
  await form.getByLabel('Where should the helper meet you?').fill('Bench by the post office');
  await form.getByRole('button', { name: 'Send request' }).click();
  await expect(page).toHaveURL(/\/requests\/[0-9a-f-]{36}$/);
  const requestId = page.url().split('/').pop() ?? '';

  const sent = page.getByRole('region', { name: 'What you sent' });
  await sent.getByRole('button', { name: 'Edit request' }).click();
  await sent.getByLabel('Short summary').fill(`${original} and back`);

  const helper = await newPerson(browser);
  await signUp(helper, request, {
    email: uniqueEmail('stale-helper'),
    name: 'Lee K.',
    county: 'San Benito',
    role: 'serve',
  });

  // Take the request just after the requester's detail poll, so the open form still holds
  // the status it loaded when Save is pressed (the next poll is 15 s away).
  await page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' &&
      response.url().endsWith(`/api/v0/service-requests/${requestId}`),
  );
  await helper.getByRole('button', { name: new RegExp(`Take this request: .*${tag}`) }).click();
  await expect(helper).toHaveURL(new RegExp(`/serve/requests/${requestId}$`));

  const edit = page.waitForResponse((response) =>
    response.url().endsWith(`/service-requests/${requestId}/commands/edit`),
  );
  await sent.getByRole('button', { name: 'Save changes' }).click();
  const refused = await edit;
  expect(refused.status()).toBe(409);
  expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('STALE_STATE');
  await expect(sent.getByRole('alert')).toHaveText(
    'This request changed while you were editing. Someone may have accepted it. Your changes were not saved.',
  );

  // The server kept the original text.
  await page.reload();
  await expect(page.getByText('Lee K. accepted your request.')).toBeVisible();
  await expect(page.getByRole('region', { name: 'What you sent' })).toContainText(original);
  await expect(page.getByRole('region', { name: 'What you sent' })).not.toContainText('and back');
});
