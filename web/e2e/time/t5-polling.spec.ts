import { expect, test } from '../fixtures';
import { POLL_MARGIN_MS, pauseAfterPoll, requestHelp, runClock } from '../helpers';
import { closePeople, helper, uniqueSummary, veteran } from '../support/support';

test.afterEach(closePeople);

/** Short enough that only the fake clock, not the real one, can have fired the poll. */
const SOON = { timeout: 5_000 };
/** The client polls (src/features/request/api.ts REQUEST_POLL_MS, serve/api.ts BOARD_REFRESH_MS). */
const REQUEST_POLL_MS = 15_000;
const BOARD_POLL_MS = 30_000;
const isOpenList = (url: string) => /\/api\/v0\/service-requests\?.*ownership=open/.test(url);

test('T5: the request page polls every 15 s, so the requester sees the accept with no reload', async ({
  browser,
  request,
}) => {
  const requester = await veteran(browser, request, { name: 'Marcus T.', county: 'Santa Clara' });
  await requester.page.clock.install();
  const summary = uniqueSummary('Ride to the clinic');
  const requestId = await requestHelp(
    requester.page,
    request,
    { category: 'TRANSPORTATION', summary, timing: 'Tomorrow at 9 am' },
    'Front entrance of the library',
  );
  await expect(requester.page.getByText('Your request has been received.')).toBeVisible();
  await pauseAfterPoll(
    requester.page,
    (url) => url.endsWith(`/api/v0/service-requests/${requestId}`),
    REQUEST_POLL_MS,
  );

  const taker = await helper(browser, request, { name: 'Dee R.', county: 'Santa Clara' });
  await taker.getByRole('button', { name: new RegExp(`Take this request: .*${summary}`) }).click();
  await expect(taker).toHaveURL(new RegExp(`/serve/requests/${requestId}$`));

  // Not just before the next poll; shown once it lands.
  await runClock(requester.page, REQUEST_POLL_MS - POLL_MARGIN_MS);
  await expect(requester.page.getByText('Dee R. accepted your request.')).toHaveCount(0);
  await runClock(requester.page, POLL_MARGIN_MS);
  await requester.page.clock.resume();
  await expect(requester.page.getByText('Dee R. accepted your request.')).toBeVisible(SOON);
});

test('T5: the open board polls every 30 s, so a new request appears with no reload', async ({
  browser,
  request,
}) => {
  const board = await helper(browser, request, { name: 'Sam P.', county: 'Merced' });
  await board.clock.install();
  await board.goto('/serve');
  await expect(
    board.getByRole('region', { name: 'Open requests' }).getByRole('heading', {
      name: 'Open requests',
    }),
  ).toBeVisible();
  await pauseAfterPoll(board, isOpenList, BOARD_POLL_MS);

  const requester = await veteran(browser, request, { name: 'Ana P.', county: 'Merced' });
  const summary = uniqueSummary('Groceries');
  await requestHelp(
    requester.page,
    request,
    { category: 'FOOD', summary },
    'Front entrance of the library',
  );

  const take = board.getByRole('button', { name: new RegExp(`Take this request: .*${summary}`) });
  await expect(take).toHaveCount(0);
  await runClock(board, BOARD_POLL_MS - POLL_MARGIN_MS);
  await expect(take).toHaveCount(0);
  await runClock(board, POLL_MARGIN_MS);
  await board.clock.resume();
  await expect(take).toBeVisible(SOON);
});
