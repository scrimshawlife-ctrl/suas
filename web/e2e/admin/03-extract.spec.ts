import { expect, test } from '../fixtures';
import { scriptModel, shoot } from '../helpers';
import { errorCode, expectNoDeadControls, nextResponse } from '../auth/auth';
import { elevatedAdmin, extractDrafts, scriptExtraction, uniqueName } from './admin';

const EXTRACT = /\/api\/v0\/admin\/resource-drafts\/commands\/extract$/;

test('Create drafts with missing or bad input says what to fix and sends nothing', async ({
  browser,
  request,
}) => {
  const page = await elevatedAdmin(browser, request);
  const extracts: string[] = [];
  page.on('request', (r) => {
    if (EXTRACT.test(new URL(r.url()).pathname)) extracts.push(r.url());
  });
  await page.goto('/admin/drafts');
  await expect(page.getByRole('heading', { level: 1, name: 'Resource drafts' })).toBeVisible();
  await expect(page).toHaveTitle('Resource drafts · SUAS Admin');
  await expectNoDeadControls(page);

  await page.getByRole('button', { name: 'Create drafts' }).click();
  await expect(page.getByText('Paste the source text.')).toBeVisible();
  await expect(page.getByText('Enter the link to the source.')).toBeVisible();
  await expect(page.getByLabel('Source text')).toBeFocused();

  await page.getByLabel('Source text').fill('   ');
  await page.getByLabel('Source link').fill('pantry.example.invalid/hours');
  await page.getByRole('button', { name: 'Create drafts' }).click();
  await expect(page.getByText('Paste the source text.')).toBeVisible();
  await expect(
    page.getByText('Enter a web link that starts with http:// or https://.'),
  ).toBeVisible();

  await page.getByLabel('Source text').fill('Some pantry text.');
  await page.getByLabel('Source link').fill('ftp://pantry.example.invalid/hours');
  await page.getByRole('button', { name: 'Create drafts' }).click();
  await expect(
    page.getByText('Enter a web link that starts with http:// or https://.'),
  ).toBeVisible();
  await expect(page.getByLabel('Source link')).toBeFocused();
  await expect(page.getByText('Paste the source text.')).toHaveCount(0);
  await expect(page.getByText('17 of 30,000 characters')).toBeVisible();
  await shoot(page, 'admin-03-extract-invalid');
  expect(extracts).toEqual([]);
});

test('several resources from one source become several drafts, listed under To review', async ({
  browser,
  request,
}) => {
  const page = await elevatedAdmin(browser, request);
  const a = uniqueName('Harbor Ride Share');
  const b = uniqueName('Bayview Night Shelter');
  await page.goto('/admin/drafts');
  await extractDrafts(page, request, [
    { service_name: a, category: 'TRANSPORTATION', counties: ['ALAMEDA'] },
    { service_name: b, category: 'SHELTER', counties: [] },
  ]);
  const created = page.getByRole('status').filter({ hasText: 'Created 2 drafts.' });
  await expect(created.getByRole('link', { name: a })).toBeVisible();
  await expect(created.getByRole('link', { name: b })).toBeVisible();
  // The form clears after a successful extract.
  await expect(page.getByLabel('Source text')).toHaveValue('');
  await expect(page.getByLabel('Source link')).toHaveValue('');

  // Both show up in the To review list, with plain category and county words.
  const list = page.getByRole('region', { name: 'Drafts' });
  const rowA = list.getByRole('listitem').filter({ hasText: a });
  await expect(rowA).toContainText('Transportation. Alameda.');
  await expect(rowA).toContainText('To review');
  await expect(list.getByRole('listitem').filter({ hasText: b })).toContainText(
    'Shelter. No county limit stated.',
  );
  await expectNoDeadControls(page);

  // Status tabs change the address and the list; Back walks them back.
  await page.getByRole('button', { name: 'Published' }).click();
  await expect(page).toHaveURL(/\/admin\/drafts\?status=PUBLISHED$/);
  await expect(list.getByRole('listitem').filter({ hasText: a })).toHaveCount(0);
  await page.getByRole('button', { name: 'Discarded' }).click();
  await expect(page).toHaveURL(/\/admin\/drafts\?status=REJECTED$/);
  await page.goBack();
  await expect(page).toHaveURL(/status=PUBLISHED$/);
  await expect(page.getByRole('button', { name: 'Published', pressed: true })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/admin\/drafts$/);
  await expect(page.getByRole('button', { name: 'To review', pressed: true })).toBeVisible();
  await expect(list.getByRole('link', { name: a })).toBeVisible();

  // An unknown status in the address falls back to To review.
  await page.goto('/admin/drafts?status=NOPE');
  await expect(page.getByRole('button', { name: 'To review', pressed: true })).toBeVisible();
  await expect(list.getByRole('link', { name: a })).toBeVisible();
});

test('a source with no resources in it makes no drafts and keeps the text to adjust', async ({
  browser,
  request,
}) => {
  const page = await elevatedAdmin(browser, request);
  await page.goto('/admin/drafts');
  await scriptExtraction(request, []);
  await page.getByLabel('Source text').fill('A page about something else entirely.');
  await page.getByLabel('Source link').fill('https://other.example.invalid/');
  await page.getByRole('button', { name: 'Create drafts' }).click();
  await expect(
    page.getByText('No resources were found in that text. No drafts were created.'),
  ).toBeVisible();
  await expect(page.getByLabel('Source text')).toHaveValue('A page about something else entirely.');
  await expect(page.getByLabel('Source link')).toHaveValue('https://other.example.invalid/');
});

test('when the builder fails or is unavailable, the page says so in plain words and a retry works', async ({
  browser,
  request,
  allow,
}) => {
  // Provoked on purpose: the browser logs each refused load.
  allow.push(/commands\/extract :: 50[023]$/, /status of 50[023]/);
  const page = await elevatedAdmin(browser, request);
  const name = uniqueName('Riverside Food Shelf');
  await page.goto('/admin/drafts');
  await page.getByLabel('Source text').fill(`${name}. Groceries on Tuesdays.`);
  await page.getByLabel('Source link').fill('https://food.example.invalid/');
  const alert = page.getByRole('alert');

  // The scripted model declines: the real API answers 502 CATALOG_EXTRACTION_FAILED.
  await scriptModel(request, [{ ok: false, failure: 'refused' }]);
  let answer = nextResponse(page, 'POST', EXTRACT);
  await page.getByRole('button', { name: 'Create drafts' }).click();
  expect((await answer).status()).toBe(502);
  expect(await errorCode(await answer)).toBe('CATALOG_EXTRACTION_FAILED');
  await expect(alert).toHaveText(
    'The catalog builder could not read this text. No drafts were created. Try again, or shorten the text.',
  );
  // Nothing typed is lost.
  await expect(page.getByLabel('Source text')).toHaveValue(`${name}. Groceries on Tuesdays.`);
  await shoot(page, 'admin-03-extract-model-failed');

  // Nothing scripted: the fake model is unavailable and the real API answers 503.
  answer = nextResponse(page, 'POST', EXTRACT);
  await page.getByRole('button', { name: 'Create drafts' }).click();
  expect((await answer).status()).toBe(503);
  await expect(alert).toHaveText(
    'The catalog builder is not available right now, so no drafts can be created from a source.',
  );

  // A 500 cannot be reached on the real stack, so it is routed.
  await page.route('**/resource-drafts/commands/extract', (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }),
  );
  await page.getByRole('button', { name: 'Create drafts' }).click();
  await expect(alert).toHaveText(
    'We could not create drafts. Check your connection and try again.',
  );
  await page.unroute('**/resource-drafts/commands/extract');

  // A retry with the model back makes the draft, and the alert goes.
  await scriptExtraction(request, [{ service_name: name, category: 'FOOD' }]);
  await page.getByRole('button', { name: 'Create drafts' }).click();
  await expect(page.getByText('Created 1 draft.')).toBeVisible();
  await expect(alert).toHaveCount(0);
  await expect(
    page.getByRole('region', { name: 'Drafts' }).getByRole('link', { name }),
  ).toBeVisible();
});

test('double-clicking Create drafts makes the drafts once', async ({ browser, request }) => {
  const page = await elevatedAdmin(browser, request);
  const name = uniqueName('Double Tap Pantry');
  await page.goto('/admin/drafts');
  const extracts: string[] = [];
  page.on('request', (r) => {
    if (EXTRACT.test(new URL(r.url()).pathname)) extracts.push(r.url());
  });
  await scriptExtraction(request, [{ service_name: name, category: 'FOOD' }]);
  await page.getByLabel('Source text').fill(`${name}. Open Mondays.`);
  await page.getByLabel('Source link').fill('https://double.example.invalid/');
  await page.getByRole('button', { name: 'Create drafts' }).dblclick();
  await expect(page.getByText('Created 1 draft.')).toBeVisible();
  const list = page.getByRole('region', { name: 'Drafts' });
  await expect(list.getByRole('link', { name })).toHaveCount(1);
  await page.reload();
  await expect(list.getByRole('link', { name })).toHaveCount(1);
  expect(extracts).toHaveLength(1);
});

test('refreshing with text typed in keeps the admin on the drafts page, signed in and stepped up', async ({
  browser,
  request,
}) => {
  const page = await elevatedAdmin(browser, request);
  await page.goto('/admin/drafts?status=REJECTED');
  await page.getByLabel('Source text').fill('Half pasted…');
  await page.reload();
  await expect(page).toHaveURL(/\/admin\/drafts\?status=REJECTED$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Resource drafts' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Discarded', pressed: true })).toBeVisible();
});

test('more than one page of drafts: Show more loads the rest, then goes away', async ({
  browser,
  request,
}) => {
  const page = await elevatedAdmin(browser, request);
  const batch = uniqueName('Batch');
  const resources = Array.from({ length: 22 }, (_, i) => ({
    service_name: `${batch} pantry ${String(i + 1).padStart(2, '0')}`,
    category: 'FOOD' as const,
  }));
  await page.goto('/admin/drafts');
  await extractDrafts(page, request, resources);
  const list = page.getByRole('region', { name: 'Drafts' });
  const ours = list.getByRole('link', { name: new RegExp(`^${batch} pantry`) });
  // The first page holds 20 drafts at most.
  await expect(list.getByRole('listitem')).toHaveCount(20);
  const more = page.getByRole('button', { name: 'Show more' });
  await more.click();
  await expect(ours).toHaveCount(22);
  // Older drafts from earlier tests may follow; keep going until the list ends.
  await expect(async () => {
    if ((await more.isVisible()) && (await more.isEnabled())) await more.click();
    await expect(more).toHaveCount(0, { timeout: 1000 });
  }).toPass();
});
