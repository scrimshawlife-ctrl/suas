/**
 * M4: the requester cancels while the helper has the case open. The helper's next command gets a
 * real 409 and the page says so in plain words, showing the cancellation.
 */

import { expect, test } from '../fixtures';
import {
  cancelOwnRequest,
  newHelper,
  newRequester,
  progress,
  sendRequest,
  summaryValue,
  take,
} from '../serve/serve';

test.describe.configure({ timeout: 180_000 });

test('a command on the case page after the Veteran cancelled gets 409 and shows the cancellation', async ({
  browser,
  request,
  allow,
}) => {
  // The errors this test provokes on purpose.
  allow.push(/status of 409/);
  const requester = await newRequester(browser, request, { name: 'Marcus T.' });
  const { id, summary } = await sendRequest(requester, request);
  const { page } = await newHelper(browser, request, { name: 'Dee R.' });
  await take(page, summary, id);
  await expect(page.getByRole('button', { name: "I've started helping" })).toBeVisible();

  // Allowed from ACCEPTED; the helper's open page does not poll.
  await cancelOwnRequest(requester, id);

  const answer = page.waitForResponse((r) => r.url().endsWith(`/${id}/commands/START`));
  await page.getByRole('button', { name: "I've started helping" }).click();
  expect((await answer).status()).toBe(409);
  await expect(
    progress(page).getByText("That step isn't available right now. We refreshed the request."),
  ).toBeVisible();
  await expect(progress(page)).toContainText('Cancelled');
  await expect(progress(page).getByRole('button')).toHaveCount(0);

  // The board drops it from "You're helping" and does not count it as closed.
  await page.getByRole('link', { name: 'Back to Serve' }).click();
  await expect(page.getByRole('region', { name: "You're helping" })).not.toContainText(summary);
  await expect(summaryValue(page, "You're helping now")).toHaveText('0');
  await expect(summaryValue(page, 'Closed in the last 30 days')).toHaveText('0');
});
