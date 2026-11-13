import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { withDb } from '../helpers';
import { closePeople, expectCrisisChrome, serverError, veteran } from './support';

test.afterEach(closePeople);

/** The seeded Santa Clara listings, one per released category (src/cli/seed-local.ts). */
const SEEDED = [
  {
    slug: 'food',
    heading: 'Food',
    name: 'Example Community Food Pantry (synthetic)',
    band: 'Need food or essential supplies?',
    category: 'FOOD',
  },
  {
    slug: 'transportation',
    heading: 'Transportation',
    name: 'Example Volunteer Rides (synthetic)',
    band: 'Need a ride?',
    category: 'TRANSPORTATION',
  },
  {
    slug: 'shelter',
    heading: 'Housing',
    name: 'Example Emergency Shelter (synthetic)',
    band: 'Need a place to stay?',
    category: 'SHELTER',
  },
  {
    slug: 'peer_support',
    heading: 'Peer support',
    name: 'Example Peer Support Circle (synthetic)',
    band: 'Want to talk with another veteran?',
    category: 'PEER_SUPPORT',
  },
] as const;

function listing(page: Page, name: string) {
  return page
    .getByRole('region', { name: 'Local listings' })
    .getByRole('listitem')
    .filter({ has: page.getByRole('heading', { level: 3, name, exact: true }) });
}

test('each released category lists its county listing with real contact targets and a request band', async ({
  browser,
  request,
}) => {
  const { page } = await veteran(browser, request, { name: 'Marcus T.', county: 'Santa Clara' });
  for (const item of SEEDED) {
    await page.goto(`/resources/${item.slug}`);
    await expect(page).toHaveTitle(`${item.heading} · SUAS`);
    await expect(page.getByRole('heading', { level: 1, name: item.heading })).toBeVisible();
    await expect(
      page.getByText('Listings for Santa Clara County.', { exact: false }),
    ).toBeVisible();
    await expect(listing(page, item.name)).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: item.band })).toBeVisible();
    await expect(
      page.getByRole('link', {
        name: item.category === 'PEER_SUPPORT' ? 'Request peer support' : 'Request essentials',
      }),
    ).toHaveAttribute('href', `/request?category=${item.category}`);
    await expectCrisisChrome(page);
  }

  // Structured contacts are links; free text is shown as written.
  await page.goto('/resources/food');
  const pantry = listing(page, SEEDED[0].name);
  await expect(
    pantry.getByRole('link', { name: /^Call Example Community Food Pantry/ }),
  ).toHaveAttribute('href', /^tel:\+?\d{7,15}$/);
  await expect(pantry.getByRole('link', { name: 'Visit website' })).toHaveAttribute(
    'href',
    'https://pantry.example.invalid/',
  );
  await expect(pantry.getByRole('link', { name: /^Email / })).toHaveAttribute('href', /^mailto:/);
  await page.goto('/resources/transportation');
  const rides = listing(page, SEEDED[1].name);
  await expect(
    rides.getByText('Request through the person who accepts your request'),
  ).toBeVisible();
  await expect(rides.getByRole('link')).toHaveCount(0);
  await page.goto('/resources/peer_support');
  await expect(
    listing(page, SEEDED[3].name).getByRole('link', { name: /^Email / }),
  ).toHaveAttribute('href', /^mailto:/);
});

test('a county with no listings shows the empty state and still offers a request', async ({
  browser,
  request,
}) => {
  // Admin scenarios may publish county-less FOOD and SHELTER listings; peer support has none.
  const { page } = await veteran(browser, request, { name: 'Pat K.', county: 'San Benito' });
  await page.goto('/resources/peer_support');
  await expect(page.getByText('Listings for San Benito County.', { exact: false })).toBeVisible();
  await expect(page.getByText('No listings for your county yet.')).toBeVisible();
  await expect(page.getByText(/Showing \d+ of/)).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Request peer support' })).toHaveAttribute(
    'href',
    '/request?category=PEER_SUPPORT',
  );
});

test('more listings than one page: "Show more listings" loads the rest', async ({
  browser,
  request,
}) => {
  // Eleven verified copies of the seeded pantry in Stanislaus: one more than a page of ten.
  const tag = randomUUID().slice(0, 6);
  const names = Array.from({ length: 11 }, (_, i) => `Paging Pantry ${tag} ${String(i + 1)}`);
  await withDb((db) =>
    db.query(
      `INSERT INTO resources (resource_id, tenant_id, service_name, category, eligibility, counties,
         hours, contact_method, contact_method_kind, cost, active, last_verified_at,
         verification_source, contacts, area)
       SELECT gen_random_uuid(), r.tenant_id, n.name, r.category, r.eligibility,
         ARRAY['STANISLAUS'], r.hours, r.contact_method, r.contact_method_kind, r.cost, true,
         r.last_verified_at, r.verification_source, r.contacts, r.area
         FROM resources r, unnest($1::text[]) AS n(name)
        WHERE r.service_name = 'Example Community Food Pantry (synthetic)'`,
      [names],
    ),
  );

  const { page } = await veteran(browser, request, { name: 'Ida P.', county: 'Stanislaus' });
  await page.goto('/resources/food');
  // Each "Show more listings" adds a page; click until every listing is shown.
  const showing = page.getByText(/^Showing \d+ of \d+$/);
  await expect(showing).toHaveText(/^Showing 10 of \d+$/);
  for (;;) {
    const [shown, total] = ((await showing.textContent()) ?? '').match(/\d+/g)!.map(Number);
    if (shown === total) break;
    await page.getByRole('button', { name: 'Show more listings' }).click();
    await expect(showing).not.toHaveText(`Showing ${String(shown)} of ${String(total)}`);
  }
  for (const name of names) await expect(listing(page, name)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Show more listings' })).toHaveCount(0);
});

test('when the listings fail to load, the page says so and Try again recovers', async ({
  browser,
  request,
  allow,
}) => {
  // The 500s are the ones this test returns on purpose.
  allow.push(/:: 500$/, /status of 500/);
  const { page } = await veteran(browser, request, { name: 'Sam D.', county: 'Santa Clara' });
  let fail = true;
  await page.route('**/api/v0/resources?**', (route) =>
    fail ? route.fulfill(serverError()) : route.fallback(),
  );
  await page.goto('/resources/food');
  await expect(page.getByRole('alert')).toContainText(
    'Something went wrong on our side. Try to load the listings again.',
    { timeout: 30_000 },
  );
  fail = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(listing(page, SEEDED[0].name)).toBeVisible();
});
