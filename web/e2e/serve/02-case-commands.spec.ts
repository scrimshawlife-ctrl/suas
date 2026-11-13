/**
 * The Case page (/serve/requests/:id): start → done → close and release, what the Veteran sees
 * after each, double clicks, the contact log with every outcome, deep links and phone width.
 * Ported from the QA sweep's serve/02-case-commands; the command after a cancel is multi/m4.
 */

import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { readSignInCode, shoot, signInWithCode } from '../helpers';
import {
  PHONE,
  newHelper,
  newRequester,
  openList,
  progress,
  sendRequest,
  summaryValue,
  take,
  takeButton,
} from './serve';

// Several people sign up per test.
test.describe.configure({ timeout: 180_000 });

const NOT_FOUND = "We couldn't find that request.";

/** Counts the POSTs of each progress command the page sends for one request. */
function countCommands(page: Page, id: string): Record<string, number> {
  const counts: Record<string, number> = {};
  page.on('request', (r) => {
    const match = new RegExp(`/service-requests/${id}/commands/([A-Z_]+)$`).exec(r.url());
    if (r.method() === 'POST' && match?.[1]) counts[match[1]] = (counts[match[1]] ?? 0) + 1;
  });
  return counts;
}

test('the helper starts, marks done and closes, and the Veteran sees each step', async ({
  browser,
  request,
}) => {
  const vet = await newRequester(browser, request, { name: 'Marcus T.' });
  const { id, summary } = await sendRequest(vet, request);
  const { page } = await newHelper(browser, request, { name: 'Dee R.' });
  const commands = countCommands(page, id);
  await take(page, summary, id);
  await expect(progress(page)).toContainText('Ready to start');
  await expect(page.getByRole('button', { name: 'Release this request' })).toBeVisible();

  await vet.reload();
  await expect(vet.getByText('Dee R. accepted your request.')).toBeVisible();
  await expect(vet.getByRole('link', { name: 'Message' })).toBeVisible();

  // Start: the next step is offered, not run, and release is no longer possible.
  await page.getByRole('button', { name: "I've started helping" }).click();
  await expect(progress(page)).toContainText('In progress');
  await expect(page.getByRole('button', { name: 'Mark as done' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Release this request' })).toHaveCount(0);
  // Back, Forward and refresh show the same state; nothing re-runs.
  await page.goBack();
  await expect(page).toHaveURL(/\/serve$/);
  await page.goForward();
  await expect(progress(page)).toContainText('In progress');
  await page.reload();
  await expect(progress(page)).toContainText('In progress');
  expect(commands['START']).toBe(1);

  await page.getByRole('button', { name: 'Mark as done' }).click();
  await expect(progress(page)).toContainText('Marked as done');
  await expect(progress(page)).toContainText("Waiting for Marcus T. to confirm it's done.");
  await expect(progress(page).getByRole('button')).toHaveCount(0);
  expect(commands['FULFILL']).toBe(1);

  await vet.reload();
  await expect(vet.getByText('Dee R. marked this request as done.')).toBeVisible();
  await vet.getByRole('button', { name: "Confirm it's done" }).click();
  await expect(vet.getByText('You confirmed this request is done.')).toBeVisible();
  await expect(vet.getByRole('button', { name: "Confirm it's done" })).toHaveCount(0);

  // The case page does not poll; a refresh shows the confirmation and Close.
  await page.reload();
  await expect(progress(page)).toContainText('Confirmed');
  await page.getByRole('button', { name: 'Close this request' }).click();
  await expect(progress(page)).toContainText('Closed');
  await expect(progress(page).getByRole('button')).toHaveCount(0);
  expect(commands['CLOSE']).toBe(1);
  await shoot(page, 'serve-02-case-closed');

  await page.goBack();
  await expect(page).toHaveURL(/\/serve$/);
  await expect(page.getByRole('region', { name: "You're helping" })).not.toContainText(summary);
  await expect(summaryValue(page, "You're helping now")).toHaveText('0');
  await expect(summaryValue(page, 'Closed in the last 30 days')).toHaveText('1');
  await page.goForward();
  await expect(progress(page)).toContainText('Closed');
  await expect(progress(page).getByRole('button')).toHaveCount(0);

  await vet.goto('/requests');
  await expect(vet.getByRole('link', { name: new RegExp(summary) })).toContainText('Done');
});

test('the contact log saves every outcome once, each through its own route, and lists it in History', async ({
  browser,
  request,
  allow,
}) => {
  // The errors this test provokes on purpose.
  // Only the routed contact save may 500; a real backend 500 still fails the test.
  allow.push(/\/commands\/complete-contact :: 500$/, /status of 500/);
  const vet = await newRequester(browser, request, { name: 'Marcus T.' });
  const { id, summary } = await sendRequest(vet, request);
  const { page } = await newHelper(browser, request, { name: 'Dee R.' });
  await take(page, summary, id);

  const log = page.getByRole('region', { name: 'Log a contact attempt' });
  const history = page.getByLabel('History');
  // PENDING goes through log-contact-attempt; the five settled outcomes through complete-contact.
  const attempts = [
    {
      channel: 'Phone',
      outcome: 'No answer',
      line: 'Phone call, no answer',
      route: 'complete-contact',
    },
    {
      channel: 'In the app',
      outcome: 'Waiting to hear',
      line: 'Message in the app, waiting to hear',
      route: 'log-contact-attempt',
    },
    {
      channel: 'Text',
      outcome: 'Reached them',
      line: 'Text message, reached Marcus',
      route: 'complete-contact',
    },
    {
      channel: 'Email',
      outcome: 'Left a message',
      line: 'Email, left a message',
      route: 'complete-contact',
    },
    {
      channel: 'Phone',
      outcome: 'They declined',
      line: 'Phone call, Marcus declined',
      route: 'complete-contact',
    },
    {
      channel: 'Text',
      outcome: "Couldn't try",
      line: "Text message, couldn't try",
      route: 'complete-contact',
    },
  ];
  for (const attempt of attempts) {
    await log.getByRole('radio', { name: attempt.channel, exact: true }).check();
    await log.getByRole('radio', { name: attempt.outcome, exact: true }).check();
    const saved = page.waitForResponse(
      (r) => r.request().method() === 'POST' && r.url().endsWith(`/commands/${attempt.route}`),
    );
    await log.getByRole('button', { name: 'Save contact attempt' }).click();
    expect((await saved).status(), attempt.line).toBe(201);
    await expect(log.getByRole('status')).toHaveText('Saved.');
    await expect(history.getByText(attempt.line, { exact: true })).toHaveCount(1);
  }

  // A refresh keeps all six, after "Request opened" and "You accepted".
  await page.reload();
  await expect(history.getByRole('listitem')).toHaveCount(attempts.length + 2);
  for (const attempt of attempts) {
    await expect(history.getByText(attempt.line, { exact: true })).toHaveCount(1);
  }

  // A failed save (5xx, page.route) says so and keeps the choice for a retry.
  await page.route('**/commands/complete-contact', (route) =>
    route.fulfill({ status: 500, body: '{}' }),
  );
  await log.getByRole('radio', { name: 'Email', exact: true }).check();
  await log.getByRole('radio', { name: 'No answer', exact: true }).check();
  await log.getByRole('button', { name: 'Save contact attempt' }).click();
  await expect(log.getByRole('status')).toHaveText("That didn't save. Try again.");
  await page.unroute('**/commands/complete-contact');
  await log.getByRole('button', { name: 'Save contact attempt' }).click();
  await expect(history.getByText('Email, no answer', { exact: true })).toBeVisible();
});

test('releasing needs a reason, runs once, and the helper can take the request again later', async ({
  browser,
  request,
  allow,
}) => {
  // The errors this test provokes on purpose.
  allow.push(/status of 404/);
  const vet = await newRequester(browser, request, { name: 'Marcus T.' });
  const { id, summary } = await sendRequest(vet, request);
  const helper = await newHelper(browser, request, { name: 'Dee R.' });
  const page = helper.page;
  const commands = countCommands(page, id);
  await take(page, summary, id);
  // The same helper on a second device, with the case open while the first releases.
  const stale = await (await browser.newContext()).newPage();
  await signInWithCode(stale, request, helper.email, 'serve');
  await expect(stale).toHaveURL(/\/serve$/);
  await stale.goto(`/serve/requests/${id}`);
  await expect(stale.getByRole('button', { name: "I've started helping" })).toBeVisible();

  await page.getByRole('button', { name: 'Release this request' }).click();
  const dialog = page.getByRole('dialog', { name: 'Release this request?' });
  // Spaces alone are not a reason.
  await dialog.getByLabel(/Why are you releasing it/).fill('   ');
  await expect(dialog.getByRole('button', { name: 'Confirm release' })).toBeDisabled();
  await dialog.getByLabel(/Why are you releasing it/).fill('My car broke down.');
  await dialog.getByRole('button', { name: 'Confirm release' }).click();
  await expect(page).toHaveURL(/\/serve$/);
  expect(commands['RELEASE']).toBe(1);

  // Back after release: the old case page says it is gone, with no commands.
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/serve/requests/${id}$`));
  await expect(page.getByRole('heading', { name: NOT_FOUND })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Release this request' })).toHaveCount(0);
  await page.goForward();
  await expect(page).toHaveURL(/\/serve$/);

  // The stale device's command fails and the page shows the request is no longer theirs.
  await stale.getByRole('button', { name: "I've started helping" }).click();
  await expect(stale.getByRole('heading', { name: NOT_FOUND })).toBeVisible();

  // The Veteran gets exactly one release notice.
  await vet.goto('/notifications');
  await expect(
    vet.getByText('The helper released your request. It is back on the open list.'),
  ).toHaveCount(1);

  // The same helper may take it again: a new accept, with a fresh chat.
  await page.reload();
  await expect(takeButton(page, summary)).toBeVisible();
  await take(page, summary, id);
  await expect(progress(page)).toContainText('Ready to start');
  await page.getByRole('link', { name: 'Open chat with Marcus' }).click();
  await expect(page.getByRole('heading', { name: 'Marcus T.' })).toBeVisible();
  await expect(page.getByLabel('Message Marcus T.')).toBeVisible();
});

test('deep links to a case: someone else’s, a missing id, a malformed id, and signed out', async ({
  browser,
  request,
  allow,
}) => {
  // The errors this test provokes on purpose.
  allow.push(/status of 40[04]/);
  const vet = await newRequester(browser, request, { name: 'Marcus T.' });
  const { id, summary } = await sendRequest(vet, request);
  const owner = await newHelper(browser, request, { name: 'Dee R.' });
  await take(owner.page, summary, id);
  const { page } = await newHelper(browser, request, { name: 'Sam P.' });

  for (const target of [id, randomUUID(), 'not-a-request']) {
    const read = page.waitForResponse((r) =>
      r.url().endsWith(`/api/v0/service-requests/${target}`),
    );
    await page.goto(`/serve/requests/${target}`);
    expect((await read).status()).toBe(target === 'not-a-request' ? 400 : 404);
    // A 4xx is final: the page says so at once, not after retries (SERVE-2, SERVE-4).
    await expect(page.getByRole('heading', { name: NOT_FOUND })).toBeVisible({ timeout: 3_000 });
    await expect(page).toHaveTitle('Case · SUAS');
    await expect(page.getByText('Where to meet')).toHaveCount(0);
  }
  await page.getByRole('main').getByRole('link', { name: 'Back to Serve' }).last().click();
  await expect(page).toHaveURL(/\/serve$/);

  // Signed out: sign in, then land on the case that was asked for.
  const signedOut = await (await browser.newContext()).newPage();
  await signedOut.goto(`/serve/requests/${id}`);
  await expect(signedOut).toHaveURL(/\/sign-in$/);
  await signedOut.getByRole('radio', { name: /I want to serve/ }).check();
  await signedOut.getByLabel('Email address').fill(owner.email);
  await signedOut.getByRole('button', { name: 'Send sign-in code' }).click();
  await expect(signedOut).toHaveURL(/\/sign-in\/code$/);
  await signedOut.getByLabel('6-digit code').fill(await readSignInCode(request, owner.email));
  await signedOut.getByRole('button', { name: 'Verify and continue' }).click();
  await expect(signedOut).toHaveURL(new RegExp(`/serve/requests/${id}$`));
  await expect(signedOut.getByRole('heading', { level: 1, name: summary })).toBeVisible();
});

test('on a phone the case page fits the screen and every command is reachable', async ({
  browser,
  request,
}) => {
  const vet = await newRequester(browser, request, { name: 'Marcus T.' });
  const { id, summary } = await sendRequest(vet, request);
  const { page } = await newHelper(browser, request, { name: 'Dee R.', viewport: PHONE });
  await expect(openList(page)).toContainText(summary);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await take(page, summary, id);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await expect(page.getByRole('region', { name: "What's needed" })).toContainText(
    'Front entrance of the library',
  );
  await page.getByRole('button', { name: "I've started helping" }).click();
  await expect(progress(page)).toContainText('In progress');
  await shoot(page, 'serve-02-case-phone');
  await page.getByRole('link', { name: 'Open chat with Marcus' }).click();
  await expect(page).toHaveURL(new RegExp(`/chat/${id}$`));
});

test('double-clicking a case command or "Save contact attempt" sends it once and shows no error', async ({
  browser,
  request,
}) => {
  // SERVE-3: one double click must not send the POST twice under one Idempotency-Key.
  const vet = await newRequester(browser, request, { name: 'Marcus T.' });
  const { id, summary } = await sendRequest(vet, request);
  const { page } = await newHelper(browser, request, { name: 'Dee R.' });
  const commands = countCommands(page, id);
  let saves = 0;
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith('/commands/complete-contact')) saves += 1;
  });
  await take(page, summary, id);

  await page.getByRole('button', { name: "I've started helping" }).dblclick();
  await expect(progress(page)).toContainText('In progress');
  await expect(page.getByRole('button', { name: 'Mark as done' })).toBeEnabled();
  await expect(progress(page).getByText(/did not go through|isn't available/)).toHaveCount(0);

  const log = page.getByRole('region', { name: 'Log a contact attempt' });
  await log.getByRole('button', { name: 'Save contact attempt' }).dblclick();
  await expect(page.getByLabel('History').getByText('Phone call, reached Marcus')).toHaveCount(1);
  await expect(log.getByRole('status')).toHaveText('Saved.');

  expect(commands['START'], 'START requests for one double click').toBe(1);
  expect(saves, 'contact saves for one double click').toBe(1);
});
