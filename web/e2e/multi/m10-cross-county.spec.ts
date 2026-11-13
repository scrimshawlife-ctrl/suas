/**
 * M10: a helper in a county that does not border the request's never sees it, and a deep link
 * to its case or chat is the same not-found as a request that does not exist (API.md §4).
 */

import { expect, test } from '../fixtures';
import { newHelper, newRequester, openList, sendRequest } from '../serve/serve';

test.describe.configure({ timeout: 180_000 });

test('a helper in another county gets not-found for the case and the chat of a request', async ({
  browser,
  request,
  allow,
}) => {
  // The errors this test provokes on purpose.
  allow.push(/status of 404/);
  // Santa Cruz and Alameda share no border (migrations/0013_peer_matching.sql).
  const requester = await newRequester(browser, request, { name: 'Rosa M.', county: 'Santa Cruz' });
  const { id, summary } = await sendRequest(requester, request);
  const near = await newHelper(browser, request, { name: 'Dee R.', county: 'Santa Cruz' });
  await expect(openList(near.page)).toContainText(summary);

  const { page } = await newHelper(browser, request, { name: 'Sam P.', county: 'Alameda' });
  await expect(openList(page).getByText('Loading open requests…')).toHaveCount(0);
  await expect(openList(page)).not.toContainText(summary);

  const read = page.waitForResponse((r) => r.url().endsWith(`/api/v0/service-requests/${id}`));
  await page.goto(`/serve/requests/${id}`);
  expect((await read).status()).toBe(404);
  await expect(page.getByRole('heading', { name: "We couldn't find that request." })).toBeVisible();
  await expect(page.getByText('Where to meet')).toHaveCount(0);

  const messages = page.waitForResponse((r) =>
    r.url().includes(`/api/v0/service-requests/${id}/chat/messages`),
  );
  await page.goto(`/chat/${id}`);
  expect((await messages).status()).toBe(404);
  await expect(page.getByRole('alert')).toHaveText("We couldn't find that conversation.");
  await expect(page.getByRole('textbox')).toHaveCount(0);
});
