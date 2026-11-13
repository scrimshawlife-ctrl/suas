/**
 * Chat refusals from the real API: CHAT_UNAVAILABLE before anyone accepts, 404 for an unknown or
 * foreign conversation and for a released helper, CHAT_CLOSED on a thread a release ended, and
 * the loads that fail when the network drops. Ported in part from the QA sweep's serve/03-chat.
 */

import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Browser, Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { shoot, signInWithCode } from '../helpers';
import { newHelper, newRequester, release, sendRequest, tag, take } from '../serve/serve';
import { history, pair, say, threadLink } from './chat';

test.describe.configure({ timeout: 180_000 });

/** Resolves with the status and error code of the next chat send the page makes. */
function nextSend(page: Page, id: string): Promise<{ status: number; code: string | undefined }> {
  return page
    .waitForResponse(
      (r) =>
        r.request().method() === 'POST' &&
        r.url().includes(`/api/v0/service-requests/${id}/chat/messages`),
    )
    .then(async (r) => ({
      status: r.status(),
      code: ((await r.json()) as { error?: { code?: string } }).error?.code,
    }));
}

test('deep links to chats: an unknown id, someone else’s request, before anyone accepts, and signed out', async ({
  browser,
  request,
  allow,
}) => {
  // The errors this test provokes on purpose.
  allow.push(/status of 40[49]/);
  const { helper: page, id } = await pair(browser, request);
  const waiting = await newRequester(browser, request, { name: 'Rosa M.' });
  const open = await sendRequest(waiting, request);

  for (const target of [randomUUID(), open.id]) {
    await page.goto(`/chat/${target}`);
    await expect(page.getByRole('alert')).toHaveText("We couldn't find that conversation.");
    await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
    await expect(page.getByRole('textbox')).toHaveCount(0);
  }

  // The Veteran opens chat before anyone accepted: a real 409 CHAT_UNAVAILABLE, said plainly.
  const read = waiting.waitForResponse((r) =>
    r.url().includes(`/api/v0/service-requests/${open.id}/chat/messages`),
  );
  await waiting.goto(`/chat/${open.id}`);
  const answer = await read;
  expect(answer.status()).toBe(409);
  expect(((await answer.json()) as { error: { code: string } }).error.code).toBe(
    'CHAT_UNAVAILABLE',
  );
  await expect(waiting.getByRole('alert')).toHaveText(
    'Chat opens once someone accepts your request.',
  );
  await expect(waiting.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  await expect(waiting.getByRole('textbox')).toHaveCount(0);

  // Signed out: sign in first.
  const stranger = await (await browser.newContext()).newPage();
  await stranger.goto(`/chat/${id}`);
  await expect(stranger).toHaveURL(/\/sign-in$/);
});

test('after a release the old helper loses the chat, a stale chat page cannot post, and the next helper starts fresh', async ({
  browser,
  request,
  allow,
}) => {
  // The errors this test provokes on purpose.
  allow.push(/status of 404/);
  const { requester, helper: page, helperEmail, id, summary } = await pair(browser, request);
  await page.goto(`/chat/${id}`);
  const before = `I can drive you ${tag()}`;
  await say(page, 'Marcus T.', before);

  // The same helper has the chat open on a second device.
  const device = await (await browser.newContext()).newPage();
  await signInWithCode(device, request, helperEmail, 'serve');
  await expect(device).toHaveURL(/\/serve$/);
  await device.goto(`/chat/${id}`);
  await expect(device.getByLabel('Message Marcus T.')).toBeVisible();

  await page.goto(`/serve/requests/${id}`);
  await release(page, 'Something came up.');

  // The released helper no longer has the conversation (DISPATCH.md §14.10, R8.11).
  await page.goto('/chat');
  await expect(page.getByText('You have no conversations yet.')).toBeVisible();
  await page.goto(`/chat/${id}`);
  await expect(page.getByText(before)).toHaveCount(0);
  await expect(page.getByLabel('Message Marcus T.')).toHaveCount(0);

  // The stale page on the other device: the send is refused (404) and the person is told.
  const refused = nextSend(device, id);
  await device.getByLabel('Message Marcus T.').fill(`Still there? ${tag()}`);
  await device.getByRole('button', { name: 'Send', exact: true }).click();
  expect((await refused).status).toBe(404);
  // A 404 is final (G5, #280): Could not send, with no Try again.
  await expect(history(device).getByText('Could not send.')).toBeVisible();
  await shoot(device, 'chat-02-stale-after-release');

  // A new helper takes it and starts with an empty chat; the Veteran sees only the new one live.
  const next = await newHelper(browser, request, { name: 'Sam P.' });
  await take(next.page, summary, id);
  await next.page.goto(`/chat/${id}`);
  await expect(next.page.getByRole('heading', { name: 'Marcus T.' })).toBeVisible();
  await expect(history(next.page)).not.toContainText(before);
  const hello = `Hi Marcus, Sam here ${tag()}`;
  await say(next.page, 'Marcus T.', hello);
  await requester.goto(`/chat/${id}`);
  await expect(requester.getByRole('heading', { name: 'Sam P.' })).toBeVisible();
  await expect(history(requester)).toContainText(hello);
  await expect(history(requester)).not.toContainText(before);
  // The old helper's device still cannot see the new chat.
  await device.reload();
  await expect(device.getByText(hello)).toHaveCount(0);
});

/**
 * The requester has the live chat open when the helper releases, then sends from that page:
 * the thread is now closed, so the API answers 409 CHAT_CLOSED. Returns the requester's page.
 */
async function sendAfterRelease(
  browser: Browser,
  request: APIRequestContext,
): Promise<{ requester: Page; text: string; status: number; code: string | undefined }> {
  const { requester, helper, id } = await pair(browser, request);
  await requester.goto(`/chat/${id}`);
  await expect(requester.getByLabel('Message Dee R.')).toBeVisible();
  await helper.goto(`/serve/requests/${id}`);
  await release(helper);

  const answer = nextSend(requester, id);
  const text = `Are you still coming? ${tag()}`;
  await requester.getByLabel('Message Dee R.').fill(text);
  await requester.getByRole('button', { name: 'Send', exact: true }).click();
  return { requester, text, ...(await answer) };
}

test('a send on a chat a release closed gets CHAT_CLOSED and is not stored', async ({
  browser,
  request,
  allow,
}) => {
  // The errors this test provokes on purpose.
  allow.push(/status of 409/);
  const { requester, text, status, code } = await sendAfterRelease(browser, request);
  expect(status).toBe(409);
  expect(code).toBe('CHAT_CLOSED');
  await expect(history(requester).getByText('Could not send.')).toBeVisible();
  // A reload shows the closed thread without the refused message.
  await requester.reload();
  await expect(
    requester.getByText('This helper released the request. This chat is closed.'),
  ).toBeVisible();
  await expect(history(requester).getByText(text)).toHaveCount(0);
  await expect(requester.getByRole('textbox')).toHaveCount(0);
});

// G5 (#280): a 4xx other than 408/429 is final: no Try again, and the reason is shown.
test('a CHAT_CLOSED send is final: no "Try again", and the person is told why', async ({
  browser,
  request,
  allow,
}) => {
  // The errors this test provokes on purpose.
  allow.push(/status of 409/);
  const { requester, text, code } = await sendAfterRelease(browser, request);
  expect(code).toBe('CHAT_CLOSED');
  await expect(history(requester).getByText(text)).toBeVisible();
  await expect(history(requester).getByText(/closed/i)).toBeVisible();
  await expect(history(requester).getByRole('button', { name: 'Try again' })).toHaveCount(0);
});

test('when the conversation or the list cannot load, the person is told and Try again recovers', async ({
  browser,
  request,
  allow,
}) => {
  // The errors this test provokes on purpose.
  allow.push(/ERR_INTERNET_DISCONNECTED/);
  const { helper: page, id } = await pair(browser, request);
  await page.goto(`/chat/${id}`);
  const text = `Running late, 10 minutes ${tag()}`;
  await say(page, 'Marcus T.', text);

  // The network drops the conversation's reads (page.route, the offline case).
  const messagesUrl = `**/api/v0/service-requests/${id}/chat/messages*`;
  await page.route(messagesUrl, (route) => route.abort('internetdisconnected'));
  await page.reload();
  await expect(page.getByText("We couldn't load this conversation. Try again.")).toBeVisible({
    timeout: 20_000,
  });
  await page.unroute(messagesUrl);
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(history(page).getByText(text)).toHaveCount(1);

  const threadsUrl = '**/api/v0/chat/threads*';
  await page.route(threadsUrl, (route) => route.abort('internetdisconnected'));
  await page.goto('/chat');
  await expect(page.getByText("We couldn't load your conversations.")).toBeVisible({
    timeout: 20_000,
  });
  await page.unroute(threadsUrl);
  await page
    .getByRole('navigation', { name: 'Conversations' })
    .getByRole('button', { name: 'Try again' })
    .click();
  await expect(threadLink(page, /Marcus T\./)).toBeVisible();
});
