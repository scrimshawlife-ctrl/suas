import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { requestHelp } from '../helpers';
import { fastDoubleClick, helper, recordAlerts, recordPosts, take, tag, veteran } from './request';

/** The chip the request carries on /requests and in Home's "Your requests". */
async function expectListChip(page: Page, summary: string, chip: string): Promise<void> {
  await page.goto('/requests');
  await expect(
    page.getByRole('main').getByRole('link', { name: new RegExp(summary) }),
  ).toContainText(chip);
  await page.goto('/home');
  await expect(
    page
      .getByRole('region', { name: 'Your requests' })
      .getByRole('link', { name: new RegExp(summary) }),
  ).toContainText(chip);
}

test('the requester follows a request from open to accepted, in progress, done, confirmed and closed', async ({
  browser,
  request,
}) => {
  // Two people walk the whole lifecycle: more steps than the default timeout allows for.
  test.slow();
  const page = await veteran(browser, request, { name: 'Marcus T.' });
  const summary = `Ride to the clinic ${tag()}`;
  const id = await requestHelp(
    page,
    request,
    { category: 'TRANSPORTATION', summary, timing: 'Tomorrow at 9 am' },
    'Front entrance of the library',
  );
  const detail = `/requests/${id}`;

  // Open: received, editable, cancellable, no Message yet.
  await expect(page).toHaveTitle('Your request · SUAS');
  await expect(page.getByRole('status').filter({ hasText: 'Request received' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit request' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel request' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Message' })).toHaveCount(0);
  await expectListChip(page, summary, 'Received');

  // Accepted by a second person, through Serve.
  const helperPage = await helper(browser, request, { name: 'Dee R.' });
  await take(helperPage, summary, id);
  await page.goto(detail);
  await expect(page.getByRole('heading', { name: 'Dee R. accepted your request.' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'A veteran accepted' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit request' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Message' })).toHaveAttribute('href', `/chat/${id}`);
  await expectListChip(page, summary, 'Accepted');

  // The Message link opens the chat with the helper.
  await page.goto(detail);
  await page.getByRole('link', { name: 'Message' }).click();
  await expect(page).toHaveURL(new RegExp(`/chat/${id}$`));
  await expect(page.getByRole('heading', { name: 'Dee R.' })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`${detail}$`));

  // In progress: still the accepted card for the requester.
  await helperPage.getByRole('button', { name: "I've started helping" }).click();
  await expect(helperPage.getByRole('region', { name: 'Progress' })).toContainText('In progress');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Dee R. accepted your request.' })).toBeVisible();
  await expect(page.getByRole('button', { name: "Confirm it's done" })).toHaveCount(0);
  await expectListChip(page, summary, 'Accepted');

  // Done: the requester is asked to confirm; Cancel is no longer offered.
  await helperPage.getByRole('button', { name: 'Mark as done' }).click();
  await expect(helperPage.getByRole('region', { name: 'Progress' })).toContainText(
    'Marked as done',
  );
  await page.goto(detail);
  await expect(page.getByText('Dee R. marked this request as done.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel request' })).toHaveCount(0);
  await expectListChip(page, summary, 'Marked done');

  await page.goto(detail);
  await page.getByRole('button', { name: "Confirm it's done" }).click();
  await expect(page.getByText('You confirmed this request is done.')).toBeVisible();
  await expect(page.getByRole('button', { name: "Confirm it's done" })).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expectListChip(page, summary, 'Done');

  // Back to the request after confirming: still confirmed, nothing to press again.
  await page.goBack();
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`${detail}$`));
  await expect(page.getByText('You confirmed this request is done.')).toBeVisible();
  await expect(page.getByRole('button', { name: "Confirm it's done" })).toHaveCount(0);

  // Closed by the helper: the requester's list says Done and shows the closing date.
  await helperPage.goto(`/serve/requests/${id}`);
  await helperPage.getByRole('button', { name: 'Close this request' }).click();
  await expect(helperPage.getByRole('region', { name: 'Progress' })).toContainText('Closed');
  await page.goto('/requests');
  const row = page.getByRole('main').getByRole('link', { name: new RegExp(summary) });
  await expect(row).toContainText('Done');
  await expect(row).toContainText(/Closed \w+ \d+/);
  await row.click();
  await expect(page).toHaveURL(new RegExp(`${detail}$`));
  await expect(
    page.getByRole('button', { name: /Cancel request|Edit request|Confirm/ }),
  ).toHaveCount(0);
});

test('the requester can cancel after a helper accepted, and the helper sees it cancelled', async ({
  browser,
  request,
}) => {
  const page = await veteran(browser, request, { name: 'Marcus T.' });
  const summary = `Someone to talk to ${tag()}`;
  const id = await requestHelp(page, request, { category: 'PEER_SUPPORT', summary }, 'Park bench');
  const helperPage = await helper(browser, request, { name: 'Dee R.' });
  await take(helperPage, summary, id);

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Dee R. accepted your request.' })).toBeVisible();
  // Cancel is offered after accept (ACCEPTED has a CANCEL edge, DISPATCH.md §4).
  await page.getByRole('button', { name: 'Cancel request' }).click();
  const dialog = page.getByRole('dialog', { name: 'Cancel this request?' });
  await dialog.getByRole('button', { name: 'Cancel request' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Request cancelled.' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Message' })).toHaveCount(0);

  // The helper's case page shows it ended, with nothing left to do.
  await helperPage.goto(`/serve/requests/${id}`);
  await expect(helperPage.getByText(/[Cc]ancelled/).first()).toBeVisible();
  await expect(helperPage.getByRole('button', { name: "I've started helping" })).toHaveCount(0);
});

test("double-clicking Confirm it's done sends one confirmation and shows no error", async ({
  browser,
  request,
}) => {
  const page = await veteran(browser, request, { name: 'Marcus T.' });
  const summary = `Someone to talk to ${tag()}`;
  const id = await requestHelp(page, request, { category: 'PEER_SUPPORT', summary }, 'Park bench');
  const helperPage = await helper(browser, request, { name: 'Dee R.' });
  await take(helperPage, summary, id);
  await helperPage.getByRole('button', { name: "I've started helping" }).click();
  await expect(helperPage.getByRole('region', { name: 'Progress' })).toContainText('In progress');
  await helperPage.getByRole('button', { name: 'Mark as done' }).click();
  await expect(helperPage.getByRole('region', { name: 'Progress' })).toContainText(
    'Marked as done',
  );

  await page.reload();
  const posts = recordPosts(page, /\/commands\/CONFIRM$/);
  const alerts = await recordAlerts(page);
  await fastDoubleClick(page.getByRole('button', { name: "Confirm it's done" }));
  await expect(page.getByText('You confirmed this request is done.')).toBeVisible();
  expect(await alerts(), 'no error flashes up').toEqual([]);
  expect(posts.map((p) => p.status)).toEqual([200]);
});
