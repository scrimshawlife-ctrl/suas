import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { draftTurns, readSignInCode, requestHelp, scriptModel, uniqueEmail } from '../helpers';
import {
  closePeople,
  contactRow,
  elevatedAdmin,
  helper,
  invite,
  startCheckIn,
  uniqueSummary,
  veteran,
  veteranWithNotice,
  visitor,
} from '../support/support';

test.afterEach(closePeople);

/**
 * Counts the writes (any method but GET) the page sends to `url` from now on. A double-click
 * that is single-flight sends one; the second click lands while the first is in flight.
 */
function writes(page: Page, url: RegExp): () => number {
  let count = 0;
  page.on('request', (r) => {
    if (r.method() !== 'GET' && url.test(r.url())) count += 1;
  });
  return () => count;
}

test('onboarding, a request, a trusted contact and a Check-In answer each send one write per double-click', async ({
  browser,
  request,
}) => {
  const page = await visitor(browser);
  const email = uniqueEmail('dbl');

  await page.goto('/sign-in');
  await page.getByRole('radio', { name: /I need support/ }).check();
  await page.getByLabel('Email address').fill(email);
  const challenges = writes(page, /\/api\/v0\/auth\/challenges$/);
  await page.getByRole('button', { name: 'Send sign-in code' }).dblclick();
  await expect(page).toHaveURL(/\/sign-in\/code$/);
  expect(challenges()).toBe(1);

  await page.getByLabel('6-digit code').fill(await readSignInCode(request, email));
  const verifies = writes(page, /\/auth\/challenges\/commands\/verify$/);
  await page.getByRole('button', { name: 'Verify and continue' }).dblclick();
  await expect(page).toHaveURL(/\/welcome$/);
  expect(verifies()).toBe(1);

  await page.getByLabel('Name other veterans will see').fill('Dub L.');
  await page.getByLabel('County').selectOption({ label: 'Santa Clara' });
  const profiles = writes(page, /\/veterans\/me\/profile$/);
  await page.getByRole('button', { name: 'Save and continue' }).dblclick();
  await expect(page).toHaveURL(/\/home$/);
  expect(profiles()).toBe(1);

  await page.goto('/verify');
  // R9.1: self-attestation opens the request gate; a double click attests once.
  await page.getByRole('button', { name: 'Tell us you served' }).click();
  const attests = writes(page, /\/verification\/commands\/self-attest$/);
  await page.getByRole('button', { name: 'Yes, I served' }).dblclick();
  await expect(
    page.getByRole('heading', { name: 'Thanks. You can ask for help now.' }),
  ).toBeVisible();
  expect(attests()).toBe(1);

  // The draft card's Send request submits the draft once and makes one request.
  await scriptModel(request, draftTurns({ category: 'FOOD', summary: uniqueSummary('Groceries') }));
  await page.goto('/request');
  await page.getByLabel('Tell us what you need').fill('I need food help this week.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const card = page.getByRole('region', { name: 'Check your request' });
  await card.getByLabel('Where should the helper meet you?').fill('Front entrance of the library');
  const submits = writes(page, /\/intake\/drafts\/[^/]+\/submit$/);
  await card.getByRole('button', { name: 'Send request' }).dblclick();
  await expect(page).toHaveURL(/\/requests\/[0-9a-f-]{36}$/);
  expect(submits()).toBe(1);

  await page.goto('/trusted-contacts');
  await page.getByLabel('Who is this to you?').fill('Sister');
  await page.getByLabel('Their email').fill(uniqueEmail('sister'));
  const invites = writes(page, /\/api\/v0\/trusted-contacts$/);
  await page.getByRole('button', { name: 'Add trusted contact' }).dblclick();
  await expect(page.getByText('Added. They are listed below.')).toBeVisible();
  await expect(contactRow(page, 'Sister')).toHaveCount(1);
  expect(invites()).toBe(1);

  await startCheckIn(page);
  await page.getByRole('radio').first().check();
  const answers = writes(page, /\/check-ins\/[^/]+\/responses$/);
  await page.getByRole('button', { name: 'Save answer' }).dblclick();
  await expect(page.getByText('Question 2 of 9')).toBeVisible();
  expect(answers()).toBe(1);
});

test('Take, case commands, chat Send, Release and Cancel each send one write per double-click', async ({
  browser,
  request,
}) => {
  const requester = await veteran(browser, request, { name: 'Marcus T.', county: 'Santa Clara' });
  const summary = uniqueSummary('Ride to the clinic');
  const requestId = await requestHelp(
    requester.page,
    request,
    { category: 'TRANSPORTATION', summary, timing: 'Tomorrow at 9 am' },
    'Front entrance of the library',
  );
  const page = await helper(browser, request, { name: 'Dee R.', county: 'Santa Clara' });

  const accepts = writes(page, new RegExp(`/service-requests/${requestId}/accept$`));
  await page
    .getByRole('button', { name: new RegExp(`Take this request: .*${summary}`) })
    .dblclick();
  await expect(page).toHaveURL(new RegExp(`/serve/requests/${requestId}$`));
  await expect(page.getByLabel('History').getByText('You accepted')).toHaveCount(1);
  expect(accepts()).toBe(1);

  const commands = writes(page, new RegExp(`/service-requests/${requestId}/commands/`));
  await page.getByRole('button', { name: "I've started helping" }).dblclick();
  await expect(page.getByRole('button', { name: 'Mark as done' })).toBeEnabled();
  expect(commands()).toBe(1);

  await page.goto(`/chat/${requestId}`);
  const text = `On my way ${uniqueSummary('m')}`;
  await page.getByLabel('Message Marcus T.').fill(text);
  const messages = writes(page, /\/chat\/messages$/);
  await page.getByRole('button', { name: 'Send', exact: true }).dblclick();
  const history = page.getByRole('region', { name: 'Message history' });
  await expect(history.getByText(text)).toHaveCount(1);
  expect(messages()).toBe(1);

  // Release on a second request the helper has only taken (started cases cannot be released).
  const second = uniqueSummary('Groceries');
  const secondId = await requestHelp(
    requester.page,
    request,
    { category: 'FOOD', summary: second },
    'Front entrance of the library',
  );
  await page.goto('/serve');
  await page.getByRole('button', { name: new RegExp(`Take this request: .*${second}`) }).click();
  await expect(page).toHaveURL(new RegExp(`/serve/requests/${secondId}$`));
  await page.getByRole('button', { name: 'Release this request' }).click();
  const release = page.getByRole('dialog', { name: 'Release this request?' });
  await release.getByLabel(/Why are you releasing it/).fill('My car broke down.');
  const releases = writes(page, new RegExp(`/service-requests/${secondId}/commands/`));
  await release.getByRole('button', { name: 'Confirm release' }).dblclick();
  await expect(page).toHaveURL(/\/serve$/);
  expect(releases()).toBe(1);

  // The requester cancels the released request from its page.
  await requester.page.goto(`/requests/${secondId}`);
  await requester.page.getByRole('button', { name: 'Cancel request' }).click();
  const cancels = writes(requester.page, new RegExp(`/service-requests/${secondId}/commands/`));
  await requester.page
    .getByRole('dialog', { name: 'Cancel this request?' })
    .getByRole('button', { name: 'Cancel request' })
    .dblclick();
  await expect(requester.page.getByText('Request cancelled.')).toBeVisible();
  await expect(requester.page.getByRole('alert')).toHaveCount(0);
  expect(cancels()).toBe(1);
});

test('Accept an invitation, Stop sharing and Remove each send one write per double-click', async ({
  browser,
  request,
}) => {
  const vet = await veteranWithNotice(browser, request, 'Brother');
  const { page } = vet;

  // A second invite, accepted with a double-click by its invitee.
  const email = uniqueEmail('cousin');
  await invite(page, 'Cousin', email);
  // The invitee signs in with the invited address; no profile is needed to accept.
  const cousin = await visitor(browser);
  await cousin.goto('/sign-in');
  await cousin.getByRole('radio', { name: /I need support/ }).check();
  await cousin.getByLabel('Email address').fill(email);
  await cousin.getByRole('button', { name: 'Send sign-in code' }).click();
  await expect(cousin).toHaveURL(/\/sign-in\/code$/);
  await cousin.getByLabel('6-digit code').fill(await readSignInCode(request, email));
  await cousin.getByRole('button', { name: 'Verify and continue' }).click();
  await expect(cousin).toHaveURL(/\/welcome$/);
  await cousin.goto('/invitations');
  const accepts = writes(cousin, /\/commands\/accept$/);
  await cousin.getByRole('button', { name: 'Accept the invitation from Max D.' }).dblclick();
  await expect(cousin.getByText('You have no invitations.')).toBeVisible();
  await expect(cousin.getByRole('alert')).toHaveCount(0);
  expect(accepts()).toBe(1);

  await page.goto('/consents');
  await page.getByRole('button', { name: 'Stop sharing' }).click();
  const revokes = writes(page, /\/consents\/[^/]+\/commands\/revoke$/);
  await page
    .getByRole('dialog', { name: 'Stop sharing?' })
    .getByRole('button', { name: 'Stop sharing' })
    .dblclick();
  await expect(page.getByText('Stopped', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(revokes()).toBe(1);

  await page.goto('/trusted-contacts');
  await contactRow(page, 'Brother').getByRole('button', { name: 'Remove' }).click();
  const removes = writes(page, /\/trusted-contacts\/[^/]+\/commands\/remove$/);
  await page
    .getByRole('dialog', { name: 'Remove Brother?' })
    .getByRole('button', { name: 'Remove' })
    .dblclick();
  await expect(contactRow(page, 'Brother')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(removes()).toBe(1);
});

test('an admin Save as draft sends one write per double-click', async ({ browser, request }) => {
  const page = await elevatedAdmin(browser, request);
  await page.goto('/admin/consent-templates');
  const key = `e2e-dbl-${uniqueEmail('k').slice(4, 12)}`;
  await page.getByLabel(/Template key/).fill(key);
  await page.getByLabel(/Template text/).fill('Synthetic test template for the e2e suite.');
  const saves = writes(page, /\/admin\/consent-templates$/);
  await page.getByRole('button', { name: 'Save as draft' }).dblclick();
  await expect(page.getByText(`Saved ${key}@1 as a draft.`, { exact: false })).toBeVisible();
  expect(saves()).toBe(1);
});
