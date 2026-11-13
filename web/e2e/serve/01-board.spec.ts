/**
 * The Serve board (/serve): the empty board and its links, the open list under stale data and
 * server failures, Take under double clicks and history, and the "You're helping" list paging.
 * Ported from the QA sweep's serve/01-serve-board; the concurrent Take is multi/m1.
 */

import { expect, test } from '../fixtures';
import { ageRequest, runJobWorkerOnce, shoot } from '../helpers';
import {
  PHONE,
  cancelOwnRequest,
  newHelper,
  newRequester,
  openList,
  progress,
  seedAcceptedRequests,
  sendRequest,
  summaryValue,
  takeButton,
} from './serve';

// Several people sign up per test.
test.describe.configure({ timeout: 180_000 });

test('a new helper in a county with no requests sees an empty board, zero counts and working links', async ({
  browser,
  request,
}) => {
  // Stanislaus: no serve, chat or multi test sends a request there, so the list is empty.
  const { page } = await newHelper(browser, request, { name: 'Ana V.', county: 'Stanislaus' });

  await expect(page).toHaveURL(/\/serve$/);
  await expect(page).toHaveTitle('Serve · SUAS');
  await expect(page.getByRole('heading', { level: 1, name: 'Ready to serve, Ana.' })).toBeVisible();
  await expect(openList(page)).toContainText('No open requests right now.');
  await expect(page.getByText('Stanislaus County, newest first')).toBeVisible();
  await expect(summaryValue(page, "You're helping now")).toHaveText('0');
  await expect(summaryValue(page, 'Closed in the last 30 days')).toHaveText('0');
  await expect(page.getByRole('region', { name: "You're helping" })).toContainText(
    "You're not helping anyone right now.",
  );
  await expect(page.getByRole('region', { name: 'Alerts' })).toContainText('No alerts right now.');
  await shoot(page, 'serve-01-empty-board');

  // "See all alerts", then "Back to home" returns to Serve, not /home (SERVE-1).
  await page.getByRole('link', { name: 'See all alerts' }).click();
  await expect(page).toHaveURL(/\/notifications$/);
  await expect(page).toHaveTitle('Notifications · SUAS');
  await expect(page.getByText('You have no notifications yet.')).toBeVisible();
  await page.getByRole('link', { name: 'Back to home' }).click();
  await expect(page).toHaveURL(/\/serve$/);

  const primary = page.getByRole('navigation', { name: 'Primary' }).first();
  await primary.getByRole('link', { name: 'Chat' }).click();
  await expect(page).toHaveURL(/\/chat$/);
  await expect(page).toHaveTitle('Chat · SUAS');
  await expect(page.getByText('You have no conversations yet.')).toBeVisible();
  await expect(page.getByText('Choose a conversation to read it.')).toBeVisible();
  await primary.getByRole('link', { name: 'Home' }).click();
  await expect(page).toHaveURL(/\/serve$/);
  await page.getByRole('link', { name: 'SUAS home' }).click();
  await expect(page).toHaveURL(/\/serve$/);

  // Phone width: one column, no sideways scroll, the tab bar instead of the header nav.
  await page.setViewportSize(PHONE);
  await page.reload();
  await expect(openList(page)).toContainText('No open requests right now.');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const tabs = page.getByRole('navigation', { name: 'Primary' }).last();
  await expect(tabs.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
  await tabs.getByRole('link', { name: 'Chat' }).click();
  await expect(page).toHaveURL(/\/chat$/);
  await tabs.getByRole('link', { name: 'Home' }).click();
  await expect(page).toHaveURL(/\/serve$/);
});

test('a Veteran who also helps never sees their own request on the open list', async ({
  browser,
  request,
  allow,
}) => {
  // The errors this test provokes on purpose.
  allow.push(/status of 403/);
  const requester = await newRequester(browser, request, { name: 'Marcus T.' });
  const { id, summary } = await sendRequest(requester, request);
  const helper = await newHelper(browser, request, { name: 'Dee R.' });
  await expect(openList(helper.page)).toContainText(summary);

  // The requester switches to Serve: same county, but their own request is not offered.
  await requester
    .getByRole('navigation', { name: 'Mode' })
    .first()
    .getByRole('link', { name: 'Serve' })
    .click();
  await expect(requester).toHaveURL(/\/serve$/);
  await expect(
    requester.getByRole('heading', { level: 1, name: 'Ready to serve, Marcus.' }),
  ).toBeVisible();
  await expect(openList(requester).getByText('Loading open requests…')).toHaveCount(0);
  await expect(openList(requester)).not.toContainText(summary);
  await expect(takeButton(requester, summary)).toHaveCount(0);

  // Nor can they open it as a helper by its address (the contact log answers 403).
  await requester.goto(`/serve/requests/${id}`);
  await expect(
    requester.getByRole('heading', { name: "We couldn't find that request." }),
  ).toBeVisible();
  await expect(requester).toHaveTitle('Case · SUAS');
});

test('a stale card for a request the Veteran cancelled, or that expired, says it is no longer open', async ({
  browser,
  request,
  allow,
}) => {
  // The errors this test provokes on purpose.
  allow.push(/status of 404/);
  const cancelling = await newRequester(browser, request, { name: 'Marcus T.' });
  const cancelled = await sendRequest(cancelling, request);
  const expiring = await newRequester(browser, request, { name: 'Rosa M.' });
  const expired = await sendRequest(expiring, request);
  const { page } = await newHelper(browser, request, { name: 'Dee R.' });
  // The board refetches every 30 s and would drop a gone card by itself, so each step starts
  // from a fresh board and acts well inside that window.
  const takeGone = async (summary: string) => {
    const answer = page.waitForResponse((r) => r.url().endsWith('/accept'));
    await takeButton(page, summary).click();
    expect((await answer).status()).toBe(404);
    await expect(
      page.getByRole('status').filter({ hasText: 'That request is no longer open.' }),
    ).toBeVisible();
    await expect(takeButton(page, summary)).toHaveCount(0);
    await expect(page).toHaveURL(/\/serve$/);
  };

  await page.reload();
  await expect(takeButton(page, cancelled.summary)).toBeVisible();
  await cancelOwnRequest(cancelling, cancelled.id);
  await takeGone(cancelled.summary);

  // The other request runs past 72 hours and the scheduled sweep expires it.
  await page.reload();
  await expect(takeButton(page, expired.summary)).toBeVisible();
  await ageRequest(expired.id, 73 * 60);
  expect(runJobWorkerOnce()).toContain(expired.id);
  await takeGone(expired.summary);

  await page.reload();
  await expect(openList(page).getByText('Loading open requests…')).toHaveCount(0);
  await expect(openList(page)).not.toContainText(cancelled.summary);
  await expect(openList(page)).not.toContainText(expired.summary);
});

test('double-clicking Take accepts once, and Back, Forward and refresh after it make sense', async ({
  browser,
  request,
}) => {
  const requester = await newRequester(browser, request, { name: 'Marcus T.' });
  const { id, summary } = await sendRequest(requester, request);
  const { page } = await newHelper(browser, request, { name: 'Dee R.' });

  let accepts = 0;
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith(`/service-requests/${id}/accept`)) accepts += 1;
  });
  await takeButton(page, summary).dblclick();
  await expect(page).toHaveURL(new RegExp(`/serve/requests/${id}$`));
  await expect(page).toHaveTitle(`${summary} · SUAS`);
  await expect(page.getByRole('heading', { level: 1, name: summary })).toBeVisible();
  await expect(page.getByLabel('History').getByText('You accepted')).toHaveCount(1);
  expect(accepts, 'one accept request for a double click').toBe(1);

  // Back: the board, with the request under "You're helping" and off the open list.
  await page.goBack();
  await expect(page).toHaveURL(/\/serve$/);
  const helping = page.getByRole('region', { name: "You're helping" });
  await expect(helping).toContainText(summary);
  await expect(helping).toContainText('Marcus T.');
  await expect(openList(page)).not.toContainText(summary);
  await expect(summaryValue(page, "You're helping now")).toHaveText('1');
  // Forward: the case again, nothing re-run.
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`/serve/requests/${id}$`));
  await expect(page.getByLabel('History').getByText('You accepted')).toHaveCount(1);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: summary })).toBeVisible();
  await expect(progress(page)).toContainText('Ready to start');

  // The helping row's two buttons.
  await page.getByRole('link', { name: 'Back to Serve' }).click();
  await helping.getByRole('link', { name: 'Chat' }).click();
  await expect(page).toHaveURL(new RegExp(`/chat/${id}$`));
  await expect(page.getByRole('heading', { name: 'Marcus T.' })).toBeVisible();
  await page.goBack();
  await helping.getByRole('link', { name: 'Open case' }).click();
  await expect(page).toHaveURL(new RegExp(`/serve/requests/${id}$`));
});

test('when the open list or a Take fails on the server, the board says so and recovers', async ({
  browser,
  request,
  allow,
}) => {
  // The errors this test provokes on purpose.
  // Only the routed open list and accept may 500; a real backend 500 still fails the test.
  allow.push(/ownership=open.* :: 500$/, /\/accept :: 500$/, /status of 500/);
  const requester = await newRequester(browser, request, { name: 'Marcus T.' });
  const { id, summary } = await sendRequest(requester, request);
  const { page } = await newHelper(browser, request, { name: 'Dee R.' });

  // page.route is limited to 5xx: the API cannot be made to fail on demand.
  const openListUrl = /\/api\/v0\/service-requests\?(?=.*ownership=open)/;
  await page.route(openListUrl, (route) => route.fulfill({ status: 500, body: '{}' }));
  await page.reload();
  await expect(openList(page)).toContainText("We couldn't load the open requests.", {
    timeout: 20_000,
  });
  await page.unroute(openListUrl);
  await openList(page).getByRole('button', { name: 'Try again' }).click();
  await expect(takeButton(page, summary)).toBeVisible();

  const acceptUrl = `**/api/v0/service-requests/${id}/accept`;
  await page.route(acceptUrl, (route) => route.fulfill({ status: 500, body: '{}' }));
  await takeButton(page, summary).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'That did not go through. Try again.' }),
  ).toBeVisible();
  // The card stays so the person can try again.
  await expect(takeButton(page, summary)).toBeEnabled();
  await page.unroute(acceptUrl);
  await takeButton(page, summary).click();
  await expect(page).toHaveURL(new RegExp(`/serve/requests/${id}$`));
});

// G8 (#290): "You're helping" pages `ownership=mine` by `next_cursor` through Show more.
test('a helper holding more than one page of requests sees them all through "Show more"', async ({
  browser,
  request,
}) => {
  const requester = await newRequester(browser, request, { name: 'Marcus T.' });
  const { page } = await newHelper(browser, request, { name: 'Dee R.' });
  // One more than the server's default page (20, API.md §5).
  const summaries = await seedAcceptedRequests(request, requester, page, 21);
  const oldest = summaries[0] ?? '';
  const newest = summaries[summaries.length - 1] ?? '';

  await page.reload();
  const helping = page.getByRole('region', { name: "You're helping" });
  await expect(helping).toContainText(newest);
  await expect(helping).not.toContainText(oldest);
  await helping.getByRole('button', { name: /Show more/ }).click();
  await expect(helping).toContainText(oldest);
  await expect(helping.getByRole('link', { name: 'Open case' })).toHaveCount(21);
  await expect(helping.getByRole('button', { name: /Show more/ })).toHaveCount(0);
  await expect(summaryValue(page, "You're helping now")).toHaveText('21');
});
