import { expect, test } from '../fixtures';
import { idFromUrl, requestRows, tag, veteran } from './request';

test('the plain form explains every missing field and sends a Housing request', async ({
  browser,
  request,
}) => {
  const page = await veteran(browser, request, { name: 'Rory Q.' });
  await page.goto('/request');
  const form = page.getByRole('form', { name: 'Request form' });

  // Empty send: the kind of help and the summary are asked for; focus goes to the first.
  await form.getByRole('button', { name: 'Send request' }).click();
  await expect(form.getByText('Choose what you need.')).toBeVisible();
  await expect(form.getByText('Tell us what you need.')).toBeVisible();
  await expect(form.getByLabel('What kind of help do you need?')).toBeFocused();
  await expect(page).toHaveURL(/\/request$/);

  // Spaces only is still empty, and Housing needs a meeting place.
  await form.getByLabel('What kind of help do you need?').selectOption('SHELTER');
  await form.getByLabel('Short summary').fill('   ');
  await form.getByRole('button', { name: 'Send request' }).click();
  await expect(form.getByText('Tell us what you need.')).toBeVisible();
  await expect(form.getByText('Tell us where the helper should meet you.')).toBeVisible();
  await expect(form.getByLabel('Short summary')).toBeFocused();

  // The ride destination appears for rides only, and goes away with the ride.
  await form.getByLabel('What kind of help do you need?').selectOption('TRANSPORTATION');
  await expect(form.getByLabel(/Where are you going/)).toBeVisible();
  await form.getByLabel(/Where are you going/).fill('Clinic on First Street');
  await form.getByLabel('What kind of help do you need?').selectOption('FOOD');
  await expect(form.getByLabel(/Where are you going/)).toHaveCount(0);
  await form.getByLabel('What kind of help do you need?').selectOption('TRANSPORTATION');
  await expect(form.getByLabel(/Where are you going/)).toHaveValue('');

  // The browser limits stop text past each field's maximum.
  await expect(form.getByLabel('Short summary')).toHaveAttribute('maxlength', '280');
  await expect(form.getByLabel('When do you need it? (optional)')).toHaveAttribute(
    'maxlength',
    '120',
  );
  await expect(form.getByLabel('Where should the helper meet you?')).toHaveAttribute(
    'maxlength',
    '200',
  );

  const summary = `Housing for two nights ${tag()}`;
  await form.getByLabel('What kind of help do you need?').selectOption('SHELTER');
  await form.getByLabel('Short summary').fill(summary);
  await form.getByLabel('Where should the helper meet you?').fill('Bus station on 4th');
  await form.getByRole('button', { name: 'Send request' }).click();
  await expect(page).toHaveURL(/\/requests\/[0-9a-f-]{36}$/);
  const sent = page.getByRole('region', { name: 'What you sent' });
  await expect(sent).toContainText('Housing');
  await expect(sent).toContainText(summary);
  await expect(sent).toContainText('Bus station on 4th');
});

for (const [category, label, place] of [
  ['FOOD', 'Food', 'Library front steps'],
  ['TRANSPORTATION', 'Transportation', 'Corner of Elm and Oak'],
  ['PEER_SUPPORT', 'Peer support', ''],
] as const) {
  test(`?category=${category} opens the form on ${label} and sends it`, async ({
    browser,
    request,
  }) => {
    const page = await veteran(browser, request, { name: 'Rory Q.' });
    await page.goto(`/request?category=${category}`);
    await expect(page).toHaveTitle('Request help · SUAS');
    const form = page.getByRole('form', { name: 'Request form' });
    await expect(form.getByLabel('What kind of help do you need?')).toHaveValue(category);
    const summary = `${label} please ${tag()}`;
    await form.getByLabel('Short summary').fill(summary);
    if (place !== '') await form.getByLabel('Where should the helper meet you?').fill(place);
    if (category === 'TRANSPORTATION') {
      await form.getByLabel(/Where are you going/).fill('Clinic on First Street');
    }
    await form.getByRole('button', { name: 'Send request' }).click();
    await expect(page).toHaveURL(/\/requests\/[0-9a-f-]{36}$/);
    const sent = page.getByRole('region', { name: 'What you sent' });
    await expect(sent).toContainText(label);
    await expect(sent).toContainText(summary);
    if (place !== '') await expect(sent).toContainText(place);
    if (category === 'TRANSPORTATION') await expect(sent).toContainText('Clinic on First Street');
  });
}

test('an unknown ?category leaves the choice empty', async ({ browser, request }) => {
  const page = await veteran(browser, request, { name: 'Rory Q.' });
  await page.goto('/request?category=BENEFITS');
  await expect(
    page.getByRole('form', { name: 'Request form' }).getByLabel('What kind of help do you need?'),
  ).toHaveValue('');
});

test('double-clicking the form Send request makes one request', async ({ browser, request }) => {
  const page = await veteran(browser, request, { name: 'Rory Q.' });
  await page.goto('/request?category=PEER_SUPPORT');
  const form = page.getByRole('form', { name: 'Request form' });
  await form.getByLabel('Short summary').fill(`Someone to talk to ${tag()}`);
  await form.getByRole('button', { name: 'Send request' }).dblclick();
  await expect(page).toHaveURL(/\/requests\/[0-9a-f-]{36}$/);
  const rows = await requestRows(page);
  await expect(rows).toHaveCount(1);
});

test('a lost answer says so, keeps the form filled, and the retry makes one request', async ({
  browser,
  request,
  allow,
}) => {
  allow.push(/service-requests :: 502/, /status of 502/);
  const page = await veteran(browser, request, { name: 'Rory Q.' });
  let fail = true;
  await page.route('**/api/v0/service-requests', async (route) => {
    if (route.request().method() === 'POST' && fail) {
      // The server did the work but the answer was lost: the retry must not double it.
      const real = await route.fetch();
      expect(real.status()).toBe(201);
      await route.fulfill({
        status: 502,
        contentType: 'text/html',
        body: '<html>bad gateway</html>',
      });
      return;
    }
    await route.fallback();
  });
  await page.goto('/request?category=PEER_SUPPORT');
  const form = page.getByRole('form', { name: 'Request form' });
  const summary = `Someone to talk to ${tag()}`;
  await form.getByLabel('Short summary').fill(summary);
  await form.getByRole('button', { name: 'Send request' }).click();
  await expect(form.getByText('Something went wrong on our side. Try again.')).toBeVisible();
  await expect(form.getByLabel('Short summary')).toHaveValue(summary);
  await expect(page).toHaveURL(/\/request\?category=PEER_SUPPORT$/);

  fail = false;
  await form.getByRole('button', { name: 'Send request' }).click();
  await expect(page).toHaveURL(/\/requests\/[0-9a-f-]{36}$/);
  const rows = await requestRows(page);
  await expect(rows).toHaveCount(1);
});

test('Back from a request sent by the form shows an empty form and does not resend', async ({
  browser,
  request,
}) => {
  const page = await veteran(browser, request, { name: 'Rory Q.' });
  await page.goto('/request?category=PEER_SUPPORT');
  const form = page.getByRole('form', { name: 'Request form' });
  await form.getByLabel('Short summary').fill(`Someone to talk to ${tag()}`);
  await form.getByRole('button', { name: 'Send request' }).click();
  await expect(page).toHaveURL(/\/requests\/[0-9a-f-]{36}$/);
  const id = idFromUrl(page);

  await page.goBack();
  await expect(page).toHaveURL(/\/request\?category=PEER_SUPPORT$/);
  await expect(form.getByLabel('Short summary')).toHaveValue('');
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`/requests/${id}$`));
  const rows = await requestRows(page);
  await expect(rows).toHaveCount(1);
});
