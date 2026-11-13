/**
 * The conversation list pages through `GET /chat/threads` by `next_cursor`. The threads are
 * seeded through the API (one requester, one helper accepting each request): more than anyone
 * would take by hand.
 */

import { expect, test } from '../fixtures';
import { newHelper, newRequester, seedAcceptedRequests } from '../serve/serve';

test.describe.configure({ timeout: 300_000 });

// G8 (agent C): the list reads one page (limit 100, the server maximum) and ignores
// `next_cursor`, so a person with more than 100 conversations never sees the oldest.
test.fixme('a person with more than one page of conversations reaches the oldest through "Show more"', async ({
  browser,
  request,
}) => {
  const requester = await newRequester(browser, request, { name: 'Marcus T.' });
  const { page } = await newHelper(browser, request, { name: 'Dee R.' });
  // One more than the server's largest page (100, API.md §5).
  const summaries = await seedAcceptedRequests(request, requester, page, 101);
  const oldest = summaries[0] ?? '';
  const newest = summaries[summaries.length - 1] ?? '';

  await page.goto('/chat');
  const list = page.getByRole('navigation', { name: 'Conversations' });
  await expect(list).toContainText(newest);
  await expect(list).not.toContainText(oldest);
  await list.getByRole('button', { name: /Show more/ }).click();
  await expect(list).toContainText(oldest);
  await expect(list.getByRole('link')).toHaveCount(101);
  await expect(list.getByRole('button', { name: /Show more/ })).toHaveCount(0);
});
