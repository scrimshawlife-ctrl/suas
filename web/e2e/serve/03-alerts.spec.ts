/**
 * Serve alerts: the release notice reaches the Veteran in the Serve board's Alerts card and
 * leads to their own request, while the helper who released gets none. Ported from the QA
 * sweep's serve/04-serve-alerts (SERVE-5).
 */

import { expect, test } from '../fixtures';
import { newHelper, newRequester, release, sendRequest, take } from './serve';

test.describe.configure({ timeout: 180_000 });

test('a release notice in the Serve Alerts card leads the Veteran to their own request', async ({
  browser,
  request,
}) => {
  const vet = await newRequester(browser, request, { name: 'Marcus T.' });
  const { id, summary } = await sendRequest(vet, request);
  const helper = await newHelper(browser, request, { name: 'Dee R.' });
  await take(helper.page, summary, id);
  await release(helper.page);
  // The helper who released gets no alert of their own.
  await helper.page.reload();
  await expect(helper.page.getByRole('region', { name: 'Alerts' })).toContainText(
    'No alerts right now.',
  );

  await vet.goto('/serve');
  const notice = vet.getByRole('region', { name: 'Alerts' }).getByRole('link', {
    name: 'The helper released your request. It is back on the open list',
  });
  await expect(notice).toBeVisible();
  await notice.click();
  // The requester's request page, not the helper case page (/serve/requests/:id).
  await expect(vet).toHaveURL(new RegExp(`//[^/]+/requests/${id}$`));
  await expect(vet.getByText('Your request has been received.')).toBeVisible();
});
