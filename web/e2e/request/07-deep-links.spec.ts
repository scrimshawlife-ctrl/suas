import { randomUUID } from 'node:crypto';
import { expect, test } from '../fixtures';
import {
  newPerson,
  newVerifiedVeteran,
  readSignInCode,
  requestHelp,
  signUp,
  uniqueEmail,
} from '../helpers';
import { helper, take, tag, veteran } from './request';

const NOT_FOUND = 'We could not find that request.';

test("another Veteran's request id shows not found and leaks nothing", async ({
  browser,
  request,
  allow,
}) => {
  allow.push(/status of 404/);
  const owner = await veteran(browser, request, { name: 'Marcus T.' });
  const summary = `Ride to the clinic ${tag()}`;
  const place = `Secret corner ${tag()}`;
  const id = await requestHelp(owner, request, { category: 'TRANSPORTATION', summary }, place);

  const other = await veteran(browser, request, { name: 'Jo K.' });
  const statuses: number[] = [];
  const bodies: string[] = [];
  other.on('response', async (response) => {
    if (!response.url().includes(`/api/v0/service-requests/${id}`)) return;
    statuses.push(response.status());
    bodies.push(await response.text().catch(() => ''));
  });
  await other.goto(`/requests/${id}`);
  await expect(other.getByRole('heading', { name: NOT_FOUND })).toBeVisible();
  await expect(
    other.getByText('It may belong to someone else, or it may have been removed.'),
  ).toBeVisible();
  // The API refuses with 404, never 403, so the request's existence is not confirmed.
  expect(statuses).toContain(404);
  expect(statuses.filter((s) => s !== 404)).toEqual([]);
  await expect(other.getByRole('main')).not.toContainText(summary);
  await expect(other.getByRole('main')).not.toContainText(place);
  expect(bodies.join('\n')).not.toContain(summary);
  expect(bodies.join('\n')).not.toContain(place);
  await expect(other.getByRole('button', { name: /Cancel request|Edit request/ })).toHaveCount(0);
  await expect(other).toHaveTitle('Request · SUAS');

  await other.getByRole('link', { name: 'Back to home' }).click();
  await expect(other).toHaveURL(/\/home$/);
});

test('a request id that does not exist shows not found', async ({ browser, request, allow }) => {
  allow.push(/status of 404/);
  const page = await veteran(browser, request, { name: 'Jo K.' });
  await page.goto(`/requests/${randomUUID()}`);
  await expect(page.getByRole('heading', { name: NOT_FOUND })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
});

test('a malformed request id is treated as not found, not as a connection problem', async ({
  browser,
  request,
  allow,
}) => {
  // The API refuses a non-UUID id with 400; the page must still read it as not found.
  allow.push(/status of 400/);
  const page = await veteran(browser, request, { name: 'Jo K.' });
  await page.goto('/requests/not-a-real-id');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(NOT_FOUND);
  await expect(page.getByText('Check your connection and try again.')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
});

test('signed out, a request link goes to sign in and comes back to the request after the code', async ({
  browser,
  request,
}) => {
  const { page: owner, email } = await newVerifiedVeteran(browser, request, {
    name: 'Marcus T.',
    county: 'Santa Clara',
  });
  const summary = `Someone to talk to ${tag()}`;
  const id = await requestHelp(owner, request, { category: 'PEER_SUPPORT', summary }, 'Bench');

  // The same person, in a fresh browser with no session, opens the link.
  const fresh = await newPerson(browser);
  await fresh.goto(`/requests/${id}`);
  await expect(fresh).toHaveURL(/\/sign-in$/);
  await fresh.getByRole('radio', { name: /I need support/ }).check();
  await fresh.getByLabel('Email address').fill(email);
  await fresh.getByRole('button', { name: 'Send sign-in code' }).click();
  await expect(fresh).toHaveURL(/\/sign-in\/code$/);
  await fresh.getByLabel('6-digit code').fill(await readSignInCode(request, email));
  await fresh.getByRole('button', { name: 'Verify and continue' }).click();
  await expect(fresh).toHaveURL(new RegExp(`/requests/${id}$`));
  await expect(fresh.getByRole('region', { name: 'What you sent' })).toContainText(summary);
});

test('the helper who accepted is sent from /requests/:id to their case page', async ({
  browser,
  request,
}) => {
  const page = await veteran(browser, request, { name: 'Marcus T.' });
  const summary = `Someone to talk to ${tag()}`;
  const id = await requestHelp(page, request, { category: 'PEER_SUPPORT', summary }, 'Bench');
  const helperPage = await helper(browser, request, { name: 'Dee R.' });
  await take(helperPage, summary, id);
  // A helper never needs the ID check, so the guard must not stop them on /verify.
  await helperPage.goto(`/requests/${id}`);
  await expect(helperPage).toHaveURL(new RegExp(`/serve/requests/${id}$`));
});

test('a signed-in Veteran without the ID check opening a request link goes to Verify', async ({
  browser,
  request,
  allow,
}) => {
  // The guard asks whether this person accepted the request; the 404 is that refusal.
  allow.push(/status of 404/);
  const owner = await veteran(browser, request, { name: 'Marcus T.' });
  const summary = `Talk ${tag()}`;
  const id = await requestHelp(owner, request, { category: 'PEER_SUPPORT', summary }, 'Bench');
  const unverified = await newPerson(browser);
  await signUp(unverified, request, {
    email: uniqueEmail('req-unverified'),
    name: 'Jo K.',
    county: 'Merced',
  });
  await unverified.goto(`/requests/${id}`);
  await expect(unverified).toHaveURL(/\/verify$/);
  await expect(unverified.getByRole('main')).not.toContainText(summary);
});
