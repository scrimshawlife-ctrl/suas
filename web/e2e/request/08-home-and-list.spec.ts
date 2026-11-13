import { expect, test } from '../fixtures';
import { requestRows, seedRequests, sendPeerRequest, tag, veteran } from './request';

test("Home's Your requests matches the full list, links to each request, and See all opens the list", async ({
  browser,
  request,
}) => {
  const page = await veteran(browser, request, { name: 'Marcus T.' });

  // No requests yet: Home says so, and there is no See all.
  const region = page.getByRole('region', { name: 'Your requests' });
  await expect(region).toContainText('You have not made a request yet.');
  await expect(region.getByRole('link', { name: 'See all' })).toHaveCount(0);
  await expect(page).toHaveTitle('Home · SUAS');

  const summaries = [1, 2, 3, 4].map((n) => `Request number ${String(n)} ${tag()}`);
  const ids: string[] = [];
  for (const summary of summaries) ids.push(await sendPeerRequest(page, summary));
  const newestFirst = [...summaries].reverse();

  // Home shows the newest three, newest first, and a See all link.
  await page.goto('/home');
  const rows = region.getByRole('listitem').getByRole('link');
  await expect(rows).toHaveCount(3);
  for (const [index, summary] of newestFirst.slice(0, 3).entries()) {
    await expect(rows.nth(index)).toContainText(summary);
    await expect(rows.nth(index)).toContainText('Received');
  }
  await expect(region).not.toContainText(summaries[0] ?? '');

  // Each row opens its own request.
  for (const [index, id] of [...ids].reverse().slice(0, 3).entries()) {
    await page.goto('/home');
    await rows.nth(index).click();
    await expect(page).toHaveURL(new RegExp(`/requests/${id}$`));
    await expect(page.getByRole('region', { name: 'What you sent' })).toContainText(
      newestFirst[index] ?? '',
    );
  }

  // The newest request is the active one on Home; its card links to the same request.
  await page.goto('/home');
  await page.getByRole('link', { name: 'See request details' }).click();
  await expect(page).toHaveURL(new RegExp(`/requests/${ids[3] ?? ''}$`));
  await page.getByRole('link', { name: 'Back to home' }).click();
  await expect(page).toHaveURL(/\/home$/);

  // See all: the list has all four in the same order, with no Show more.
  await region.getByRole('link', { name: 'See all' }).click();
  await expect(page).toHaveURL(/\/requests$/);
  await expect(page).toHaveTitle('Your requests · SUAS');
  const all = page.getByRole('main').getByRole('listitem').getByRole('link');
  await expect(all).toHaveCount(4);
  for (const [index, summary] of newestFirst.entries()) {
    await expect(all.nth(index)).toContainText(summary);
  }
  await expect(page.getByRole('button', { name: 'Show more' })).toHaveCount(0);
  await all.nth(3).click();
  await expect(page).toHaveURL(new RegExp(`/requests/${ids[0] ?? ''}$`));
  await page.goBack();
  await expect(page).toHaveURL(/\/requests$/);
  await page.getByRole('link', { name: 'Back to home' }).click();
  await expect(page).toHaveURL(/\/home$/);
});

test('/requests pages past 20 requests with Show more, newest first, without repeats', async ({
  browser,
  request,
}) => {
  const page = await veteran(browser, request, { name: 'Marcus T.' });
  const run = tag();
  const summaries = Array.from({ length: 23 }, (_, n) => `Paged ${run} #${String(n + 1)}`);
  await seedRequests(page, request, summaries);
  const newestFirst = [...summaries].reverse();

  const rows = await requestRows(page);
  await expect(rows).toHaveCount(20);
  await expect(rows.first()).toContainText(newestFirst[0] ?? '');
  await expect(rows.nth(19)).toContainText(newestFirst[19] ?? '');

  const next = page.waitForResponse(
    (r) => r.url().includes('/api/v0/service-requests?') && r.url().includes('cursor='),
  );
  await page.getByRole('button', { name: 'Show more' }).click();
  expect((await next).status()).toBe(200);
  await expect(rows).toHaveCount(23);
  await expect(page.getByRole('button', { name: 'Show more' })).toHaveCount(0);
  // The second page continues where the first stopped: every request once, in order.
  const texts = await rows.allTextContents();
  newestFirst.forEach((summary, index) => expect(texts[index]).toContain(summary));

  // Home lists the newest three and links to the full list.
  await page.goto('/home');
  const region = page.getByRole('region', { name: 'Your requests' });
  await expect(region.getByRole('listitem')).toHaveCount(3);
  await expect(region.getByRole('listitem').first()).toContainText(newestFirst[0] ?? '');
  await expect(region.getByRole('link', { name: 'See all' })).toBeVisible();
});

test('a cancelled request changes its chip on Home and in the list at the same time', async ({
  browser,
  request,
}) => {
  const page = await veteran(browser, request, { name: 'Marcus T.' });
  const kept = `Keep this one ${tag()}`;
  const dropped = `Cancel this one ${tag()}`;
  await sendPeerRequest(page, kept);
  await sendPeerRequest(page, dropped);
  await page.getByRole('button', { name: 'Cancel request' }).click();
  await page
    .getByRole('dialog', { name: 'Cancel this request?' })
    .getByRole('button', { name: 'Cancel request' })
    .click();
  await expect(page.getByRole('heading', { name: 'Request cancelled.' })).toBeVisible();

  await page.getByRole('link', { name: 'Back to home' }).click();
  const region = page.getByRole('region', { name: 'Your requests' });
  await expect(region.getByRole('link', { name: new RegExp(dropped) })).toContainText('Cancelled');
  await expect(region.getByRole('link', { name: new RegExp(kept) })).toContainText('Received');
  const rows = await requestRows(page);
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: dropped })).toContainText('Cancelled');
  await expect(rows.filter({ hasText: kept })).toContainText('Received');
});

test('when the list cannot load, /requests says so and Try again recovers', async ({
  browser,
  request,
  allow,
}) => {
  allow.push(/service-requests\?.* :: 500/, /status of 500/);
  const page = await veteran(browser, request, { name: 'Marcus T.' });
  const summary = `Someone to talk to ${tag()}`;
  await sendPeerRequest(page, summary);
  let fail = true;
  await page.route('**/api/v0/service-requests?*', (route) =>
    fail && route.request().method() === 'GET'
      ? route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'boom' } }),
        })
      : route.fallback(),
  );
  await page.goto('/requests');
  // 5xx reads are retried before the page gives up.
  await expect(
    page.getByText('We could not load your requests. Check your connection.'),
  ).toBeVisible({ timeout: 30_000 });
  fail = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(
    page.getByRole('main').getByRole('link', { name: new RegExp(summary) }),
  ).toBeVisible();
});

test("Home's active request card cancels the request in place", async ({ browser, request }) => {
  const page = await veteran(browser, request, { name: 'Marcus T.' });
  const summary = `Someone to talk to ${tag()}`;
  await sendPeerRequest(page, summary);
  await page.getByRole('link', { name: 'Back to home' }).click();
  const card = page.getByRole('region', { name: 'Your QRF request' });
  await expect(card).toContainText('Your request has been received.');
  await expect(card.getByRole('list', { name: 'Request progress' })).toBeVisible();

  await card.getByRole('button', { name: 'Cancel request' }).click();
  await page
    .getByRole('dialog', { name: 'Cancel this request?' })
    .getByRole('button', { name: 'Cancel request' })
    .click();
  // The request is over: Home lists it as cancelled and offers no Cancel.
  await expect(
    page
      .getByRole('region', { name: 'Your requests' })
      .getByRole('link', { name: new RegExp(summary) }),
  ).toContainText('Cancelled');
  await expect(card.getByRole('button', { name: 'Cancel request' })).toHaveCount(0);
});
