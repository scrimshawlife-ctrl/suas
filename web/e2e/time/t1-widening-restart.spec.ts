import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { ageRequest, requestHelp, runJobWorkerOnce } from '../helpers';
import { closePeople, helper, uniqueSummary, veteran } from '../support/support';
import { ageReleases } from './time';

test.afterEach(closePeople);

const openList = (page: Page) => page.getByRole('region', { name: 'Open requests' });

test('T1: after a release the widening wait starts again, so the request widens only 30 min after the release', async ({
  browser,
  request,
}) => {
  // 03-widening covers the first widening from submit; this is the restart (R8.5,
  // src/coordination/widening.ts: the wait runs from the later of submit and last release).
  const requester = await veteran(browser, request, { name: 'Marcus T.', county: 'Santa Cruz' });
  const summary = uniqueSummary('Groceries for the week');
  const requestId = await requestHelp(
    requester.page,
    request,
    { category: 'FOOD', summary },
    'Corner of Pacific Ave and Soquel Ave',
  );

  // A same-county helper takes it, then releases it.
  const taker = await helper(browser, request, { name: 'Sam P.', county: 'Santa Cruz' });
  await taker.getByRole('button', { name: new RegExp(`Take this request: .*${summary}`) }).click();
  await expect(taker).toHaveURL(new RegExp(`/serve/requests/${requestId}$`));
  await taker.getByRole('button', { name: 'Release this request' }).click();
  const dialog = taker.getByRole('dialog', { name: 'Release this request?' });
  await dialog.getByLabel(/Why are you releasing it/).fill('My car broke down.');
  await dialog.getByRole('button', { name: 'Confirm release' }).click();
  await expect(taker).toHaveURL(/\/serve$/);

  // San Mateo borders Santa Cruz; it does not see the request before it widens.
  const bordering = await helper(browser, request, { name: 'Dee R.', county: 'San Mateo' });
  await expect(openList(bordering).getByRole('heading', { name: 'Open requests' })).toBeVisible();
  await expect(openList(bordering)).not.toContainText(summary);

  // Sent 31 minutes ago, released just now: not due yet.
  await ageRequest(requestId, 31);
  expect(runJobWorkerOnce()).not.toContain(requestId);
  await bordering.reload();
  await expect(openList(bordering).getByRole('heading', { name: 'Open requests' })).toBeVisible();
  await expect(openList(bordering)).not.toContainText(summary);

  // Released 31 minutes ago too: now it widens, marked as a nearby county.
  await ageReleases(requestId, 31);
  const output = runJobWorkerOnce();
  expect(output).toContain('"msg":"request_widened"');
  expect(output).toContain(requestId);
  await bordering.reload();
  await expect(openList(bordering)).toContainText(summary);
  const card = openList(bordering).getByRole('listitem').filter({ hasText: summary });
  await expect(card.getByText('Nearby county')).toBeVisible();
});
