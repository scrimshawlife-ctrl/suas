import { expect, test } from '../fixtures';
import { ageRequest, requestHelp, runJobWorkerOnce } from '../helpers';
import { closePeople, helper, uniqueSummary, veteran } from '../support/support';

test.afterEach(closePeople);

test('T2: a request past 72 hours leaves the open board at its next 30-second refresh, with no reload', async ({
  browser,
  request,
}) => {
  // 08-release-expiry covers the requester's side; this is the helper's board.
  const requester = await veteran(browser, request, { name: 'Marcus T.', county: 'Santa Clara' });
  const summary = uniqueSummary('Groceries');
  const requestId = await requestHelp(
    requester.page,
    request,
    { category: 'FOOD', summary },
    'Front entrance of the library',
  );

  const board = await helper(browser, request, { name: 'Dee R.', county: 'Santa Clara' });
  await board.clock.install();
  await board.goto('/serve');
  const take = board.getByRole('button', { name: new RegExp(`Take this request: .*${summary}`) });
  await expect(take).toBeVisible();

  await ageRequest(requestId, 73 * 60);
  const output = runJobWorkerOnce();
  expect(output).toContain('"msg":"request_expired"');
  expect(output).toContain(requestId);

  // The board polls every 30 s (serve/api.ts BOARD_REFRESH_MS); the fake clock fires it now.
  await board.clock.fastForward(30_000);
  await expect(take).toHaveCount(0, { timeout: 5_000 });
});
