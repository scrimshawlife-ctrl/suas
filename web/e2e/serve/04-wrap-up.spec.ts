/**
 * Wrap up (R11.1): once the requester's request is closed, its helper resolves the Case with a
 * Settlement and closes it, and with that loses the case page (standing ends on close).
 */

import { expect, test } from '../fixtures';
import { progress, sendRequest, take } from './serve';
import { newHelper, newVeteran } from '../people';

// Two people sign up.
test.describe.configure({ timeout: 180_000 });

test('the helper wraps up and closes the case, then can no longer open it', async ({
  browser,
  request,
  allow,
}) => {
  // The case page read after close answers 404 on purpose.
  allow.push(/status of 404/);
  const { page: vet } = await newVeteran(browser, request, { name: 'Marcus T.' });
  const { id, summary } = await sendRequest(vet, request);
  const { page } = await newHelper(browser, request, { name: 'Dee R.' });
  await take(page, summary, id);
  const wrapUp = page.getByRole('region', { name: 'Wrap up this case' });

  await page.getByRole('button', { name: "I've started helping" }).click();
  await page.getByRole('button', { name: 'Mark as done' }).click();
  await expect(progress(page)).toContainText('Marked as done');
  await expect(wrapUp).toHaveCount(0);

  await vet.reload();
  await vet.getByRole('button', { name: "Confirm it's done" }).click();
  await expect(vet.getByText('You confirmed this request is done.')).toBeVisible();

  await page.reload();
  await page.getByRole('button', { name: 'Close this request' }).click();
  await expect(progress(page)).toContainText('Closed');

  // The case is ASSIGNED, so Wrap up activates it, then resolves it with the typed text.
  const commands: string[] = [];
  page.on('request', (r) => {
    const match = /\/cases\/[^/]+\/commands\/([a-z-]+)$/.exec(r.url());
    if (r.method() === 'POST' && match?.[1]) commands.push(match[1]);
  });
  await wrapUp.getByLabel('What they asked for').fill('A ride to the clinic');
  await wrapUp.getByLabel('What happened').fill('Drove Marcus there and back');
  await wrapUp.getByLabel('What was done').fill('The ride');
  await wrapUp.getByLabel('Anything still open').fill('Nothing');
  await wrapUp.getByRole('button', { name: 'Wrap up' }).click();
  await expect(wrapUp).toContainText('This case is wrapped up.');
  expect(commands).toEqual(['activate', 'resolve']);

  await wrapUp.getByRole('button', { name: 'Close case' }).click();
  const dialog = page.getByRole('dialog', { name: 'Close this case?' });
  await expect(dialog).toContainText(
    'Closing ends the chat and access for every helper on this case.',
  );
  await dialog.getByRole('button', { name: 'Close case' }).click();
  await expect(page).toHaveURL(/\/serve$/);
  expect(commands).toEqual(['activate', 'resolve', 'close']);

  await page.goto(`/serve/requests/${id}`);
  await expect(page.getByRole('heading', { name: "We couldn't find that request." })).toBeVisible();
  await expect(page.getByText('Where to meet')).toHaveCount(0);
});
