import { BOARD_REFRESH_MS } from '../../src/app/poll-intervals';
import { expect, test } from '../fixtures';
import {
  pauseAfterPoll,
  POLL_MARGIN_MS,
  requestHelp,
  runClock,
  runJobWorkerOnce,
  uniqueText,
} from '../helpers';
import { closePeople } from '../support/support';
import { ageRequest } from './time';
import { newHelper, newVeteran } from '../people';

test.afterEach(closePeople);

test('T2: a request past 72 hours leaves the open board at its next 30-second refresh, with no reload', async ({
  browser,
  request,
}) => {
  // serve/05-release-and-expiry covers the requester's side; this is the helper's board.
  const requester = await newVeteran(browser, request, {
    name: 'Marcus T.',
    county: 'Santa Clara',
  });
  const summary = uniqueText('Groceries');
  const requestId = await requestHelp(
    requester.page,
    request,
    { category: 'FOOD', summary },
    'Front entrance of the library',
  );

  const { page: board } = await newHelper(browser, request, {
    name: 'Dee R.',
    county: 'Santa Clara',
  });
  await board.clock.install();
  await board.goto('/serve');
  const take = board.getByRole('button', { name: new RegExp(`Take this request: .*${summary}`) });
  await expect(take).toBeVisible();
  // The board polls on BOARD_REFRESH_MS; time stands still after a poll.
  await pauseAfterPoll(board, (url) => /ownership=open/.test(url), BOARD_REFRESH_MS);

  await ageRequest(requestId, 73 * 60);
  const output = runJobWorkerOnce();
  expect(output).toContain('"msg":"request_expired"');
  expect(output).toContain(requestId);

  // Still listed just before the next poll; gone once it lands.
  await runClock(board, BOARD_REFRESH_MS - POLL_MARGIN_MS);
  await expect(take).toBeVisible();
  await runClock(board, POLL_MARGIN_MS);
  await board.clock.resume();
  await expect(take).toHaveCount(0, { timeout: 5_000 });
});
