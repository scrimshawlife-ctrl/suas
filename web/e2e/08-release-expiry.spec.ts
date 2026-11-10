import { expect, test, type Page } from '@playwright/test';
import {
  ageRequest,
  newPerson,
  newVerifiedVeteran,
  requestHelp,
  runJobWorkerOnce,
  shoot,
  signUp,
  uniqueEmail,
} from './helpers';

const RELEASED_NOTICE = 'The helper released your request. It is back on the open list.';
const EXPIRED_NOTICE = 'Your request expired 72 hours after you sent it.';
const CLOSED_LINE = 'This helper released the request. This chat is closed.';

async function newHelper(
  browser: Parameters<typeof newPerson>[0],
  request: Parameters<typeof signUp>[1],
  name: string,
): Promise<Page> {
  const page = await newPerson(browser);
  await signUp(page, request, {
    email: uniqueEmail('helper'),
    name,
    county: 'Santa Clara',
    role: 'serve',
  });
  return page;
}

async function take(page: Page, summary: string, requestId: string): Promise<void> {
  await page.goto('/serve');
  await page.getByRole('button', { name: new RegExp(`Take this request: .*${summary}`) }).click();
  await expect(page).toHaveURL(new RegExp(`/serve/requests/${requestId}$`));
}

test('a helper releases a request, the next helper gets a fresh chat and the requester keeps the old one read-only', async ({
  browser,
  request,
}) => {
  const requester = await newVerifiedVeteran(browser, request, {
    name: 'Marcus T.',
    county: 'Santa Clara',
    label: 'requester',
  });
  const summary = `Ride to the clinic ${uniqueEmail('r').slice(6, 14)}`;
  const requestId = await requestHelp(
    requester.page,
    request,
    { category: 'TRANSPORTATION', summary, timing: 'Tomorrow at 9 am' },
    'Front entrance of the library',
  );
  const helperA = await newHelper(browser, request, 'Dee R.');
  const helperB = await newHelper(browser, request, 'Sam P.');

  await take(helperA, summary, requestId);
  await helperA.getByRole('link', { name: 'Open chat with Marcus' }).click();
  const firstMessage = `I can drive you, Marcus. ${uniqueEmail('m').slice(6, 12)}`;
  await helperA.getByLabel('Message Marcus T.').fill(firstMessage);
  await helperA.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(helperA.getByRole('region', { name: 'Message history' })).toContainText(
    firstMessage,
  );

  // Release needs a reason; Cancel leaves the request with the helper.
  await helperA.goto(`/serve/requests/${requestId}`);
  await helperA.getByRole('button', { name: 'Release this request' }).click();
  const dialog = helperA.getByRole('dialog', { name: 'Release this request?' });
  await expect(dialog.getByRole('button', { name: 'Confirm release' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(helperA.getByRole('button', { name: 'Release this request' })).toBeVisible();

  await helperA.getByRole('button', { name: 'Release this request' }).click();
  await dialog.getByLabel(/Why are you releasing it/).fill('My car broke down.');
  await dialog.getByRole('button', { name: 'Confirm release' }).click();
  await expect(helperA).toHaveURL(/\/serve$/);
  // The released helper loses the request.
  await helperA.goto(`/serve/requests/${requestId}`);
  await expect(
    helperA.getByRole('heading', { name: "We couldn't find that request." }),
  ).toBeVisible();

  // The requester is told and the request is waiting again.
  await requester.page.goto('/notifications');
  await expect(requester.page.getByText(RELEASED_NOTICE)).toBeVisible();
  await requester.page.goto(`/requests/${requestId}`);
  await expect(requester.page.getByText('Your request has been received.')).toBeVisible();
  await expect(requester.page.getByRole('link', { name: 'Message' })).toHaveCount(0);

  // Another helper accepts and starts with an empty chat.
  await take(helperB, summary, requestId);
  await helperB.getByRole('link', { name: 'Open chat with Marcus' }).click();
  await expect(helperB.getByRole('heading', { name: 'Marcus T.' })).toBeVisible();
  await expect(helperB.getByLabel('Message Marcus T.')).toBeVisible();
  await expect(helperB.getByRole('region', { name: 'Message history' })).not.toContainText(
    firstMessage,
  );

  // The requester still reads the first chat, read-only, next to the live one.
  await requester.page.goto('/chat');
  const list = requester.page.getByRole('navigation', { name: 'Conversations' });
  await expect(list.getByRole('link', { name: /Sam P\./ })).toBeVisible();
  await list.getByRole('link', { name: /Dee R\./ }).click();
  await expect(requester.page).toHaveURL(new RegExp(`/chat/${requestId}\\?thread=`));
  await expect(requester.page.getByRole('region', { name: 'Message history' })).toContainText(
    firstMessage,
  );
  await expect(requester.page.getByText(CLOSED_LINE)).toBeVisible();
  await expect(requester.page.getByRole('textbox')).toHaveCount(0);
  await shoot(requester.page, '08-closed-chat-requester');

  // The live thread is unchanged: it has the composer.
  await list.getByRole('link', { name: /Sam P\./ }).click();
  await expect(requester.page.getByLabel('Message Sam P.')).toBeVisible();
  await expect(requester.page.getByText(CLOSED_LINE)).toHaveCount(0);
});

test('a request nobody accepts expires after 72 hours and only offers a new request', async ({
  browser,
  request,
}) => {
  const requester = await newVerifiedVeteran(browser, request, {
    name: 'Marcus T.',
    county: 'Santa Clara',
    label: 'expiring',
  });
  const requestId = await requestHelp(
    requester.page,
    request,
    { category: 'FOOD', summary: `Groceries ${uniqueEmail('e').slice(6, 14)}` },
    'Corner of Pacific Ave and Soquel Ave',
  );

  await ageRequest(requestId, 73 * 60);
  expect(runJobWorkerOnce()).toContain('"msg":"request_expired"');

  await requester.page.reload();
  await expect(requester.page.getByText('We could not confirm support yet.')).toBeVisible();
  await expect(
    requester.page.getByRole('link', { name: 'Try another support category' }),
  ).toBeVisible();
  await expect(requester.page.getByRole('button', { name: /Cancel|Update|Expand/ })).toHaveCount(0);
  await shoot(requester.page, '08-expired-request');

  await requester.page.goto('/notifications');
  await expect(requester.page.getByText(EXPIRED_NOTICE)).toBeVisible();
});
