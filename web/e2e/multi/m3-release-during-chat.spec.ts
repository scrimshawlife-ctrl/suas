/**
 * M3: the helper releases while the requester has the chat open. The chat's own refetch (60 s
 * while the socket is live, driven with `page.clock`) shows the closed thread without a reload.
 */

import { expect, test } from '../fixtures';
import { history, pair, say } from '../chat/chat';
import { release, tag } from '../serve/serve';

test.describe.configure({ timeout: 180_000 });

const CLOSED_LINE = 'This helper released the request. This chat is closed.';

test('a release while the requester is in the chat shows the closed thread without a reload', async ({
  browser,
  request,
}) => {
  const { requester, helper, id } = await pair(browser, request);
  await requester.clock.install();
  await requester.goto(`/chat/${id}`);
  await expect(requester.getByLabel('Message Dee R.')).toBeVisible();
  await requester.evaluate(() => {
    (window as unknown as { __stillHere: boolean }).__stillHere = true;
  });

  await helper.goto(`/chat/${id}`);
  const before = `On my way ${tag()}`;
  await say(helper, 'Marcus T.', before);
  await expect(history(requester)).toContainText(before);

  await helper.goto(`/serve/requests/${id}`);
  await release(helper);

  await requester.clock.fastForward('01:05');
  await expect(requester.getByText(CLOSED_LINE)).toBeVisible();
  await expect(requester.getByRole('textbox')).toHaveCount(0);
  // The earlier messages stay readable.
  await expect(history(requester)).toContainText(before);
  expect(
    await requester.evaluate(() => (window as unknown as { __stillHere?: boolean }).__stillHere),
  ).toBe(true);
});
