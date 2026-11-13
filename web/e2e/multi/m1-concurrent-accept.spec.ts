/**
 * M1: two helpers press Take at the same moment. Exactly one gets the case; the other gets the
 * real 409 ALREADY_CLAIMED as "Someone else took this one." and keeps a working board.
 */

import { expect, test } from '../fixtures';
import {
  newHelper,
  newRequester,
  openList,
  sendRequest,
  summaryValue,
  takeButton,
} from '../serve/serve';

test.describe.configure({ timeout: 180_000 });

test('two helpers Take at once: one case page, and the other sees the taken copy', async ({
  browser,
  request,
  allow,
}) => {
  // The errors this test provokes on purpose.
  allow.push(/status of 409/);
  const requester = await newRequester(browser, request, { name: 'Marcus T.' });
  const { id, summary } = await sendRequest(requester, request);
  const a = (await newHelper(browser, request, { name: 'Dee R.' })).page;
  const b = (await newHelper(browser, request, { name: 'Sam P.' })).page;
  const late = (await newHelper(browser, request, { name: 'Lee K.' })).page;
  for (const page of [a, b, late]) await expect(takeButton(page, summary)).toBeEnabled();

  const accepted = (page: typeof a) =>
    page.waitForResponse((r) => r.url().endsWith(`/service-requests/${id}/accept`));
  const [answerA, answerB] = await Promise.all([
    accepted(a),
    accepted(b),
    takeButton(a, summary).click(),
    takeButton(b, summary).click(),
  ]);
  expect([answerA.status(), answerB.status()].sort()).toEqual([200, 409]);
  const [winner, loser, lost] = answerA.status() === 200 ? [a, b, answerB] : [b, a, answerA];
  expect(((await lost.json()) as { error: { code: string } }).error.code).toBe('ALREADY_CLAIMED');

  await expect(winner).toHaveURL(new RegExp(`/serve/requests/${id}$`));
  await expect(winner.getByText('You accepted').first()).toBeVisible();
  await expect(loser).toHaveURL(/\/serve$/);
  await expect(
    loser.getByRole('status').filter({ hasText: 'Someone else took this one.' }),
  ).toBeVisible();
  await expect(takeButton(loser, summary)).toHaveCount(0);
  await expect(loser.getByRole('region', { name: "You're helping" })).not.toContainText(summary);
  // A reload shows a clean board without the request.
  await loser.reload();
  await expect(openList(loser).getByText('Loading open requests…')).toHaveCount(0);
  await expect(openList(loser)).not.toContainText(summary);
  await expect(summaryValue(loser, "You're helping now")).toHaveText('0');

  // A third helper whose board still shows the card gets the same plain answer.
  await takeButton(late, summary).click();
  await expect(
    late.getByRole('status').filter({ hasText: 'Someone else took this one.' }),
  ).toBeVisible();
  await expect(late).toHaveURL(/\/serve$/);
  await expect(takeButton(late, summary)).toHaveCount(0);
});
