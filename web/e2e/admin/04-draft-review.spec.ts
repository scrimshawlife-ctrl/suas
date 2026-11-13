import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { newVerifiedVeteran, shoot, withDb } from '../helpers';
import { errorCode, expectNoDeadControls, nextResponse, sidewaysScroll } from '../auth/auth';
import { duplicateTab, elevatedAdmin, openNewDraft, uniqueName } from './admin';

const saveButton = (page: Page) => page.getByRole('button', { name: 'Save changes' });
const publishButton = (page: Page) => page.getByRole('button', { name: 'Publish', exact: true });
const discardButton = (page: Page) => page.getByRole('button', { name: 'Discard', exact: true });
const PUBLISHED = /^Published as a verified Resource\./;
const EDIT = /\/api\/v0\/admin\/resource-drafts\/[0-9a-f-]{36}\/commands\/edit$/;

// A superset of 05-catalog.spec.ts (QA port): every field, contacts, confirm dialog, reload.
test('an admin edits every field, publishes after a confirm, and a Veteran sees the edited listing', async ({
  browser,
  request,
}) => {
  const veteran = await newVerifiedVeteran(browser, request, {
    name: 'Rosa D.',
    county: 'Santa Clara',
    label: 'admin-reader',
  });
  const page = await elevatedAdmin(browser, request);
  const extracted = uniqueName('Coyote Valley Shelter');
  const name = uniqueName('Coyote Valley Food Closet');
  await openNewDraft(page, request, {
    service_name: extracted,
    category: 'SHELTER',
    counties: ['MERCED'],
    hours: 'Mon 9-5',
  });
  await expect(page).toHaveTitle(`${extracted} · SUAS Admin`);
  await expect(page.getByRole('region', { name: 'Source' })).toContainText(
    'https://source.example.invalid/listing',
  );
  await expect(page.getByText('To review', { exact: true })).toBeVisible();
  // Nothing changed yet: Save is off, Publish is on.
  await expect(saveButton(page)).toBeDisabled();
  await expect(publishButton(page)).toBeEnabled();
  await expectNoDeadControls(page);

  await page.getByLabel('Service name').fill(name);
  await page.getByLabel('Category').selectOption({ label: 'Food' });
  await page.getByRole('checkbox', { name: 'Merced' }).uncheck();
  await page.getByRole('checkbox', { name: 'Santa Clara' }).check();
  await page.getByLabel('Eligibility').fill('Veterans and their households.');
  await page.getByLabel('Hours').fill('Tuesdays 10 am to 2 pm');
  await page.getByLabel('Area').fill('Morgan Hill');
  await page.getByLabel('Referral method').fill('Walk in; no referral needed.');
  await page.getByLabel('Cost').fill('No cost');

  // Contacts: up to three, then the add button turns off; remove one and add another.
  const add = page.getByRole('button', { name: 'Add a contact method' });
  await expect(page.getByText('No contact method recorded.')).toBeVisible();
  await add.click();
  await page.getByLabel('Contact 1', { exact: true }).fill('(408) 555-0142');
  await add.click();
  await page.getByLabel('Contact 2 kind').selectOption({ label: 'Email address' });
  await page.getByLabel('Contact 2', { exact: true }).fill('closet@example.invalid');
  await add.click();
  await page.getByLabel('Contact 3 kind').selectOption({ label: 'Other' });
  await page.getByLabel('Contact 3', { exact: true }).fill('Ask for Sam at the side door');
  await expect(add).toBeDisabled();
  await page.getByRole('button', { name: 'Remove contact 2' }).click();
  await expect(page.getByLabel('Contact 3', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Contact 2', { exact: true })).toHaveValue(
    'Ask for Sam at the side door',
  );
  await expect(add).toBeEnabled();
  await add.click();
  await page.getByLabel('Contact 3 kind').selectOption({ label: 'Web address' });
  await page.getByLabel('Contact 3', { exact: true }).fill('https://closet.example.invalid');

  // Unsaved changes hold back Publish and Discard.
  await expect(page.getByText('Save your changes before you publish or discard.')).toBeVisible();
  await expect(publishButton(page)).toBeDisabled();
  await expect(discardButton(page)).toBeDisabled();
  await saveButton(page).click();
  await expect(page.getByText('Changes saved.')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  await expect(page).toHaveTitle(`${name} · SUAS Admin`);
  await expect(saveButton(page)).toBeDisabled();

  // A refresh shows the saved values, not the extracted ones.
  await page.reload();
  await expect(page.getByLabel('Service name')).toHaveValue(name);
  await expect(page.getByLabel('Category')).toHaveValue('FOOD');
  await expect(page.getByRole('checkbox', { name: 'Santa Clara' })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Merced' })).not.toBeChecked();
  await expect(page.getByLabel('Contact 2', { exact: true })).toHaveValue(
    'Ask for Sam at the side door',
  );
  await expect(page.getByLabel('Contact 3 kind')).toHaveValue('URL');
  await expect(page.getByLabel('Area')).toHaveValue('Morgan Hill');
  await shoot(page, 'admin-04-draft-edited');

  // Publish: Cancel first, then Escape (nothing happens), then confirm.
  await publishButton(page).click();
  const dialog = page.getByRole('dialog', { name: 'Publish this resource?' });
  await expect(dialog).toContainText(
    'Publishing makes this a verified Resource that veterans can see.',
  );
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('To review', { exact: true })).toBeVisible();
  await publishButton(page).click();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(publishButton(page)).toBeFocused();

  await publishButton(page).click();
  await dialog.getByRole('button', { name: 'Publish resource' }).click();
  await expect(page.getByText(PUBLISHED)).toBeVisible();
  await expect(page.getByText(PUBLISHED)).toBeFocused();
  // Read-only now: no form controls.
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await expect(saveButton(page)).toHaveCount(0);
  await expect(page.getByText('Contact 2 (Other)')).toBeVisible();
  await expect(page.getByText('Walk in; no referral needed.')).toBeVisible();

  // The Veteran sees exactly what the admin saved.
  await veteran.page.goto('/resources/food');
  const listing = veteran.page
    .getByRole('listitem')
    .filter({ has: veteran.page.getByRole('heading', { name }) });
  await expect(listing).toBeVisible();
  await expect(listing).toContainText('Morgan Hill');
  await expect(listing).toContainText('Tuesdays 10 am to 2 pm');
  await expect(listing).toContainText('No cost');
  await expect(listing).toContainText('Ask for Sam at the side door');
  await expect(listing.getByRole('link', { name: /\(408\) 555-0142/ })).toHaveAttribute(
    'href',
    'tel:4085550142',
  );
  await expect(listing.getByRole('link', { name: 'Visit website' })).toHaveAttribute(
    'href',
    'https://closet.example.invalid/',
  );
  await expect(listing.getByText(/^Verified [A-Z][a-z]{2} \d{1,2}$/)).toBeVisible();
  // The extracted (unedited) name never reached Veterans, and not under Shelter either.
  await expect(veteran.page.getByRole('heading', { name: extracted })).toHaveCount(0);
  await veteran.page.goto('/resources/shelter');
  await expect(veteran.page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(veteran.page.getByRole('heading', { name })).toHaveCount(0);
  await shoot(veteran.page, 'admin-04-veteran-sees-edited');
});

test('after publishing, Back and Forward never bring back an editable draft or publish again', async ({
  browser,
  request,
}) => {
  const page = await elevatedAdmin(browser, request);
  const name = uniqueName('Back Button Pantry');
  const publishes: string[] = [];
  page.on('request', (r) => {
    if (r.url().endsWith('/commands/publish')) publishes.push(r.url());
  });
  const id = await openNewDraft(page, request, { service_name: name, category: 'FOOD' });
  await publishButton(page).click();
  // A double-click on the confirm sends one publish (QA ADMIN-5 regression).
  await page.getByRole('button', { name: 'Publish resource' }).dblclick();
  await expect(page.getByText(PUBLISHED)).toBeVisible();
  const rows = await withDb((db) =>
    db.query('SELECT count(*)::int AS n FROM resources WHERE service_name = $1', [name]),
  );
  expect((rows.rows[0] as { n: number }).n).toBe(1);
  expect(publishes).toHaveLength(1);

  await page.goBack();
  await expect(page).toHaveURL(/\/admin\/drafts$/);
  const list = page.getByRole('region', { name: 'Drafts' });
  await expect(list.getByText(/Nothing to review|Updated/).first()).toBeVisible();
  await expect(list.getByRole('link', { name })).toHaveCount(0);
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`/admin/drafts/${id}$`));
  await expect(page.getByText(PUBLISHED)).toBeVisible();
  await expect(saveButton(page)).toHaveCount(0);
  await expect(publishButton(page)).toHaveCount(0);

  // The back link goes to the Published tab, where the draft now sits.
  await page.getByRole('link', { name: 'Back to resource drafts' }).click();
  await expect(page).toHaveURL(/\/admin\/drafts\?status=PUBLISHED$/);
  await expect(list.getByRole('listitem').filter({ hasText: name })).toContainText('Published');
  expect(publishes).toHaveLength(1);
});

test('discarding asks first; Keep draft changes nothing; a discarded draft never reaches Veterans', async ({
  browser,
  request,
}) => {
  const veteran = await newVerifiedVeteran(browser, request, {
    name: 'Abe K.',
    county: 'Alameda',
    label: 'admin-discard',
  });
  const page = await elevatedAdmin(browser, request);
  const name = uniqueName('Discard Me Shelter');
  await openNewDraft(page, request, {
    service_name: name,
    category: 'SHELTER',
    counties: ['ALAMEDA'],
  });
  await discardButton(page).click();
  const dialog = page.getByRole('dialog', { name: 'Discard this draft?' });
  await expect(dialog).toContainText('You can still read it under Discarded.');
  await dialog.getByRole('button', { name: 'Keep draft' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('To review', { exact: true })).toBeVisible();

  await discardButton(page).click();
  await dialog.getByRole('button', { name: 'Discard draft' }).click();
  await expect(page.getByText(/^Discarded\. This draft was not published\./)).toBeVisible();
  await expect(page.getByText('Discarded', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Back to resource drafts' }).click();
  await expect(page).toHaveURL(/status=REJECTED$/);
  await expect(
    page.getByRole('region', { name: 'Drafts' }).getByRole('link', { name }),
  ).toBeVisible();

  await veteran.page.goto('/resources/shelter');
  await expect(veteran.page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(veteran.page.getByRole('heading', { name })).toHaveCount(0);
});

test('the editor refuses an empty name, an empty contact row and a crisis number (real 400)', async ({
  browser,
  request,
}) => {
  const page = await elevatedAdmin(browser, request);
  const name = uniqueName('Validation Pantry');
  await openNewDraft(page, request, { service_name: name, category: 'FOOD' });
  const edits: string[] = [];
  page.on('request', (r) => {
    if (EDIT.test(new URL(r.url()).pathname)) edits.push(r.url());
  });

  await page.getByLabel('Service name').fill('  ');
  await saveButton(page).click();
  await expect(page.getByText('Enter the service name.')).toBeVisible();
  await expect(page.getByLabel('Service name')).toBeFocused();
  await page.getByLabel('Service name').fill(name);

  await page.getByRole('button', { name: 'Add a contact method' }).click();
  await saveButton(page).click();
  await expect(page.getByText('Enter each contact method, or remove the empty row.')).toBeVisible();
  await expect(page.getByLabel('Contact 1', { exact: true })).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  expect(edits, 'page-side checks send nothing').toEqual([]);

  // A crisis line is refused by the server; the message sits with the contacts.
  await page.getByLabel('Contact 1', { exact: true }).fill('988');
  const refused = nextResponse(page, 'POST', EDIT);
  await saveButton(page).click();
  expect((await refused).status()).toBe(400);
  const contacts = page.getByRole('group', { name: 'Contact methods' });
  await expect(contacts.getByRole('alert')).toBeVisible();
  await expect(page.getByText('Changes saved.')).toHaveCount(0);
  await shoot(page, 'admin-04-crisis-number-refused');

  // Fixing it saves; typing again hides the stale "Changes saved." line.
  await page.getByLabel('Contact 1', { exact: true }).fill('(209) 555-0110');
  await saveButton(page).click();
  await expect(page.getByText('Changes saved.')).toBeVisible();
  await expect(contacts.getByRole('alert')).toHaveCount(0);
  await page.getByLabel('Hours').fill('Sat 8-noon');
  await expect(page.getByText('Changes saved.')).toHaveCount(0);
});

test('double-clicking Save sends one edit; a refresh with unsaved edits shows the saved draft', async ({
  browser,
  request,
}) => {
  const page = await elevatedAdmin(browser, request);
  const edits: string[] = [];
  page.on('request', (r) => {
    if (EDIT.test(new URL(r.url()).pathname)) edits.push(r.url());
  });
  await openNewDraft(page, request, {
    service_name: uniqueName('Save Twice'),
    category: 'FOOD',
    hours: 'Mon',
  });
  await page.getByLabel('Hours').fill('Daily 7-7');
  await saveButton(page).dblclick();
  await expect(page.getByText('Changes saved.')).toBeVisible();
  expect(edits).toHaveLength(1);

  await page.getByLabel('Hours').fill('Typed but not saved');
  await page.reload();
  await expect(page.getByLabel('Hours')).toHaveValue('Daily 7-7');
  await expect(saveButton(page)).toBeDisabled();
  await expect(publishButton(page)).toBeEnabled();
});

test('a publish that fails says so inside the dialog, and trying again publishes', async ({
  browser,
  request,
}) => {
  const page = await elevatedAdmin(browser, request);
  await openNewDraft(page, request, {
    service_name: uniqueName('Flaky Publish'),
    category: 'FOOD',
  });
  // A 5xx cannot be reached on the real stack, so it is routed.
  await page.route('**/commands/publish', (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }),
  );
  await publishButton(page).click();
  const dialog = page.getByRole('dialog', { name: 'Publish this resource?' });
  await dialog.getByRole('button', { name: 'Publish resource' }).click();
  await expect(dialog.getByRole('alert')).toHaveText(
    'That did not go through. Check your connection and try again.',
  );
  await page.unroute('**/commands/publish');
  await dialog.getByRole('button', { name: 'Publish resource' }).click();
  await expect(page.getByText(PUBLISHED)).toBeVisible();
});

// M8: two tabs on one draft. The second tab publishes; the first tab's save is a real 409
// ILLEGAL_TRANSITION, and the page re-reads the draft and shows it published.
test('two admin tabs on one draft: the stale tab saves, gets 409 and shows the current state', async ({
  browser,
  request,
}) => {
  const page = await elevatedAdmin(browser, request);
  const id = await openNewDraft(page, request, {
    service_name: uniqueName('Two Tabs Pantry'),
    category: 'FOOD',
  });
  const other = await duplicateTab(page, `/admin/drafts/${id}`);
  await publishButton(other).click();
  await other.getByRole('button', { name: 'Publish resource' }).click();
  await expect(other.getByText(PUBLISHED)).toBeVisible();

  await page.bringToFront();
  await page.getByLabel('Hours').fill('Changed in the stale tab');
  const refused = nextResponse(page, 'POST', EDIT);
  const reread = page.waitForResponse(
    (r) => r.request().method() === 'GET' && r.url().endsWith(`/admin/resource-drafts/${id}`),
  );
  await saveButton(page).click();
  const response = await refused;
  expect(response.status()).toBe(409);
  expect(await errorCode(response)).toBe('ILLEGAL_TRANSITION');
  expect((await reread).status()).toBe(200);
  await expect(page.getByText(PUBLISHED)).toBeVisible();
  await expect(saveButton(page)).toHaveCount(0);
  await expect(page.getByText('To review', { exact: true })).toHaveCount(0);
  const hours = await withDb((db) =>
    db.query('SELECT hours FROM resource_drafts WHERE resource_draft_id = $1', [id]),
  );
  expect((hours.rows[0] as { hours: string | null }).hours).not.toBe('Changed in the stale tab');
});

test('a draft address that does not exist, or is malformed, reads as not found with a way back', async ({
  browser,
  request,
}) => {
  const page = await elevatedAdmin(browser, request);
  // A malformed id is a 400, shown as not found rather than a load failure (QA ADMIN-4).
  for (const id of [randomUUID(), 'abc']) {
    await page.goto(`/admin/drafts/${id}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Resource draft' })).toBeVisible();
    await expect(page.getByText('We could not find this draft.')).toBeVisible();
    await expect(page).toHaveTitle('Resource draft · SUAS Admin');
    await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  }
  await expectNoDeadControls(page);
  await page.getByRole('link', { name: 'Back to resource drafts' }).click();
  await expect(page).toHaveURL(/\/admin\/drafts$/);
});

test('a draft at phone width: the contact editor and the dialog fit without sideways scroll', async ({
  browser,
  request,
}) => {
  const page = await elevatedAdmin(browser, request);
  await page.setViewportSize({ width: 390, height: 844 });
  await openNewDraft(page, request, {
    service_name: uniqueName('Phone Width Pantry With A Fairly Long Service Name'),
    category: 'FOOD',
    contacts: [
      { kind: 'PHONE', value: '(408) 555-0100' },
      { kind: 'URL', value: 'https://a-rather-long-host-name.example.invalid/some/deep/path' },
    ],
  });
  expect(await sidewaysScroll(page)).toBeLessThanOrEqual(0);
  await page.getByRole('button', { name: 'Add a contact method' }).click();
  expect(await sidewaysScroll(page)).toBeLessThanOrEqual(0);
  await page.getByRole('button', { name: 'Remove contact 3' }).click();
  await publishButton(page).click();
  await expect(page.getByRole('dialog', { name: 'Publish this resource?' })).toBeVisible();
  expect(await sidewaysScroll(page)).toBeLessThanOrEqual(0);
  await shoot(page, 'admin-04-draft-phone-dialog');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expectNoDeadControls(page);
});
