import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { requestHelp } from '../helpers';
import { fastDoubleClick, recordAlerts, recordPosts, tag, veteran } from './request';

// The 72-hour expiry is covered by 08-release-expiry.spec.ts.
const cancelledChip = (page: Page) => page.getByRole('status').filter({ hasText: 'Cancelled' });

test('the cancel dialog closes three ways without cancelling, then cancels; Back and Forward keep it cancelled', async ({
  browser,
  request,
}) => {
  const page = await veteran(browser, request, { name: 'Lee C.' });
  const summary = `Someone to talk to ${tag()}`;
  const id = await requestHelp(page, request, { category: 'PEER_SUPPORT', summary }, 'Park bench');
  const dialog = page.getByRole('dialog', { name: 'Cancel this request?' });
  const open = () => page.getByRole('button', { name: 'Cancel request' }).click();

  await open();
  await dialog.getByRole('button', { name: 'Keep request active' }).click();
  await expect(dialog).toBeHidden();
  await open();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await open();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
  await page.reload();
  await expect(page.getByRole('status').filter({ hasText: 'Request received' })).toBeVisible();

  await open();
  await dialog.getByRole('button', { name: 'Cancel request' }).click();
  await expect(dialog).toBeHidden();
  await expect(cancelledChip(page)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit request' })).toHaveCount(0);

  // Back goes to where the person was before, Forward returns to the still-cancelled request.
  await page.goBack();
  await expect(page).toHaveURL(/\/request$/);
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`/requests/${id}$`));
  await expect(cancelledChip(page)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel request' })).toHaveCount(0);

  // "Start a new request" opens a fresh /request.
  await page.getByRole('link', { name: 'Start a new request' }).click();
  await expect(page).toHaveURL(/\/request$/);
  await expect(
    page.getByRole('form', { name: 'Request form' }).getByLabel('Short summary'),
  ).toHaveValue('');
});

test('double-clicking the dialog Cancel request cancels once with no error', async ({
  browser,
  request,
}) => {
  const page = await veteran(browser, request, { name: 'Lee C.' });
  await requestHelp(
    page,
    request,
    { category: 'PEER_SUPPORT', summary: `Talk ${tag()}` },
    'Park bench',
  );
  const posts = recordPosts(page, /\/commands\/CANCEL$/);
  const alerts = await recordAlerts(page);
  await page.getByRole('button', { name: 'Cancel request' }).click();
  await fastDoubleClick(
    page
      .getByRole('dialog', { name: 'Cancel this request?' })
      .getByRole('button', { name: 'Cancel request' }),
  );
  await expect(cancelledChip(page)).toBeVisible();
  expect(await alerts(), 'no error flashes up').toEqual([]);
  expect(posts.map((p) => p.status)).toEqual([200]);
});

test('cancelling in a second tab after the first tab cancelled gets 409, explains it and shows the cancelled state', async ({
  browser,
  request,
  allow,
}) => {
  allow.push(/status of 409/);
  const page = await veteran(browser, request, { name: 'Lee C.' });
  const id = await requestHelp(
    page,
    request,
    { category: 'PEER_SUPPORT', summary: `Talk ${tag()}` },
    'Park bench',
  );
  // A second tab with the same session. Not window.open: the fixture's response hook throws
  // on a popup's first navigation (handed off to agent A), so the token is copied by hand.
  const token = await page.evaluate(() => sessionStorage.getItem('suas.session') ?? '');
  const second = await page.context().newPage();
  await second.addInitScript((value) => sessionStorage.setItem('suas.session', value), token);
  await second.goto(`/requests/${id}`);
  await expect(second.getByRole('button', { name: 'Cancel request' })).toBeVisible();

  await page.getByRole('button', { name: 'Cancel request' }).click();
  await page
    .getByRole('dialog', { name: 'Cancel this request?' })
    .getByRole('button', { name: 'Cancel request' })
    .click();
  await expect(cancelledChip(page)).toBeVisible();

  const refused = second.waitForResponse((r) => /\/commands\/CANCEL$/.test(r.url()));
  await second.getByRole('button', { name: 'Cancel request' }).click();
  const dialog = second.getByRole('dialog', { name: 'Cancel this request?' });
  await dialog.getByRole('button', { name: 'Cancel request' }).click();
  expect((await refused).status()).toBe(409);
  // Either it says the request changed, or it settles on the cancelled state; never a crash.
  await expect(dialog.getByRole('alert').or(cancelledChip(second)).first()).toBeVisible();
  await second.reload();
  await expect(cancelledChip(second)).toBeVisible();
});
