/**
 * Back pressed at once after a release or close that started on a freshly loaded case page.
 * After a reload the /serve screen has never been loaded, so its route module is fetched while
 * the command navigates; Back must still land on a re-read case page, not the stale one with
 * the confirm dialog open. The race only shows on a slow device, so the CPU is throttled 20×.
 */

import type { CDPSession, Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { progress, sendRequest, take } from './serve';
import { newHelper, newVeteran } from '../people';

test.describe.configure({ timeout: 180_000 });

const NOT_FOUND = "We couldn't find that request.";

async function throttleCpu(page: Page): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 20 });
  return cdp;
}

/** Presses Back the moment /serve shows in the address bar, then lifts the throttle. */
async function backAtOnce(page: Page, cdp: CDPSession, id: string): Promise<void> {
  await expect(page).toHaveURL(/\/serve$/, { timeout: 60_000 });
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/serve/requests/${id}$`));
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
}

test('release after a reload, then Back at once: the case page is re-read', async ({
  browser,
  request,
  allow,
}) => {
  allow.push(/status of 404/);
  const { page: vet } = await newVeteran(browser, request, { name: 'Marcus T.' });
  const { id, summary } = await sendRequest(vet, request);
  const { page } = await newHelper(browser, request, { name: 'Dee R.' });
  await take(page, summary, id);
  await page.reload();

  await page.getByRole('button', { name: 'Release this request' }).click();
  const dialog = page.getByRole('dialog', { name: 'Release this request?' });
  await dialog.getByLabel(/Why are you releasing it/).fill('My car broke down.');
  const cdp = await throttleCpu(page);
  await dialog.getByRole('button', { name: 'Confirm release' }).click();
  await backAtOnce(page, cdp, id);

  await expect(page.getByRole('heading', { name: NOT_FOUND })).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Release this request' })).toHaveCount(0);
});

test('close after a reload, then Back at once: the closed case is gone', async ({
  browser,
  request,
  allow,
}) => {
  allow.push(/status of 40[34]/);
  const { page: vet } = await newVeteran(browser, request, { name: 'Marcus T.' });
  const { id, summary } = await sendRequest(vet, request);
  const { page } = await newHelper(browser, request, { name: 'Dee R.' });
  await take(page, summary, id);
  await page.getByRole('button', { name: "I've started helping" }).click();
  await page.getByRole('button', { name: 'Mark as done' }).click();
  await expect(progress(page)).toContainText('Marked as done');
  await vet.reload();
  await vet.getByRole('button', { name: "Confirm it's done" }).click();
  await expect(vet.getByText('You confirmed this request is done.')).toBeVisible();
  // The case page does not poll; the reload shows the confirmation.
  await page.reload();
  await page.getByRole('button', { name: 'Close this request' }).click();
  const wrapUp = page.getByRole('region', { name: 'Wrap up this case' });
  await wrapUp.getByLabel('What they asked for').fill('A ride to the clinic');
  await wrapUp.getByLabel('What happened').fill('Drove there and back');
  await wrapUp.getByLabel('What was done').fill('The ride');
  await wrapUp.getByLabel('Anything still open').fill('Nothing');
  await wrapUp.getByRole('button', { name: 'Wrap up' }).click();
  await wrapUp.getByRole('button', { name: 'Close case' }).click();

  const dialog = page.getByRole('dialog', { name: 'Close this case?' });
  const cdp = await throttleCpu(page);
  await dialog.getByRole('button', { name: 'Close case' }).click();
  await backAtOnce(page, cdp, id);

  await expect(page.getByRole('heading', { name: NOT_FOUND })).toBeVisible();
  await expect(dialog).toHaveCount(0);
});
