import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { API_URL } from './config';
import { newPerson, newVerifiedVeteran, signUp, uniqueEmail } from './helpers';

// G8: lists longer than one page load the rest by `next_cursor` through "Show more". The rows
// are seeded through the API (the same calls the screens make), then read from the pages.
const REQUESTS = 51; // over the Serve page (20) and the case list page (50)
const ATTEMPTS = 51; // over the contact-attempt page (50)

const bearer = async (page: Page) => ({
  Authorization: `Bearer ${await page.evaluate(() => sessionStorage.getItem('suas.session') ?? '')}`,
});

async function post(
  request: APIRequestContext,
  path: string,
  headers: Record<string, string>,
  data: unknown = {},
): Promise<{ service_request_id: string; case_id: string }> {
  const response = await request.post(`${API_URL}${path}`, {
    headers: { ...headers, 'Idempotency-Key': randomUUID() },
    data,
  });
  expect(response.ok(), `${path} ${String(response.status())}`).toBe(true);
  return (await response.json()) as { service_request_id: string; case_id: string };
}

test('Show more loads the next page of Serve "You\'re helping", case requests and History', async ({
  browser,
  request,
}) => {
  test.setTimeout(180_000);
  const requester = await newVerifiedVeteran(browser, request, {
    name: 'Ana P.',
    county: 'Merced',
    label: 'pager',
  });
  const requesterAuth = await bearer(requester.page);
  const tag = uniqueEmail('p').slice(6, 14);
  const created = [];
  for (let n = 1; n <= REQUESTS; n += 1) {
    created.push(
      await post(request, '/api/v0/service-requests', requesterAuth, {
        category: 'FOOD',
        summary: `Paging ${tag} #${String(n)}`,
        meeting_place: 'Front desk of the library',
      }),
    );
  }

  const helper = await newPerson(browser);
  await signUp(helper, request, {
    email: uniqueEmail('pager-helper'),
    name: 'Ben Q.',
    county: 'Merced',
    role: 'serve',
  });
  const helperAuth = await bearer(helper);
  for (const { service_request_id } of created) {
    await post(request, `/api/v0/service-requests/${service_request_id}/accept`, helperAuth);
  }

  // Serve: 20 held requests per page, then 40, then all 51 and no button.
  await helper.reload();
  const helping = helper.getByRole('region', { name: "You're helping" });
  const openCase = helping.getByRole('link', { name: 'Open case' });
  await expect(openCase).toHaveCount(20);
  await helping.getByRole('button', { name: 'Show more' }).click();
  await expect(openCase).toHaveCount(40);
  await helping.getByRole('button', { name: 'Show more' }).click();
  await expect(openCase).toHaveCount(REQUESTS);
  await expect(helping.getByRole('button', { name: 'Show more' })).toHaveCount(0);

  // The case holds all 51 requests: 50 on the first page, the last one after Show more.
  const first = created[0]!;
  for (let n = 0; n < ATTEMPTS; n += 1) {
    await post(request, `/api/v0/cases/${first.case_id}/commands/log-contact-attempt`, helperAuth, {
      channel: 'IN_APP',
      outcome: 'PENDING',
      attempted_at: new Date(Date.now() - (ATTEMPTS - n) * 60_000).toISOString(),
    });
  }
  await helper.goto(`/serve/requests/${first.service_request_id}`);
  const caseRequests = helper
    .getByRole('region', { name: 'Service requests' })
    .getByRole('listitem');
  await expect(caseRequests).toHaveCount(50);
  await helper
    .getByRole('region', { name: 'Service requests' })
    .getByRole('button', { name: 'Show more' })
    .click();
  await expect(caseRequests).toHaveCount(REQUESTS);

  // History: request opened, you accepted, then the contact attempts, 50 at a time.
  const history = helper.getByRole('region', { name: 'History' });
  await expect(history.getByRole('listitem')).toHaveCount(2 + 50);
  await history.getByRole('button', { name: 'Show more' }).click();
  await expect(history.getByRole('listitem')).toHaveCount(2 + ATTEMPTS);
  await expect(history.getByRole('button', { name: 'Show more' })).toHaveCount(0);
});
