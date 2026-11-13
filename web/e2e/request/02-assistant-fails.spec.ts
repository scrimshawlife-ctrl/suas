import { expect, test } from '../fixtures';
import { requestRows, tag, veteran } from './request';

const FALLBACK =
  'The assistant is not available right now. The simple form below sends the same request.';
const SEND_FAILED = 'Something went wrong on our side. Try again.';

test('when the assistant cannot answer, the form takes over with what the Veteran typed', async ({
  browser,
  request,
}) => {
  const page = await veteran(browser, request, { name: 'Rory Q.' });
  const typed = `I need someone to talk to tonight ${tag()}`;
  // No scripted turns: the fake model answers "unavailable" and the API returns FALLBACK_FORM.
  const reply = page.waitForResponse(
    (r) => r.request().method() === 'POST' && /\/api\/v0\/intake\/drafts$/.test(r.url()),
  );
  await page.goto('/request');
  await page.getByLabel('Tell us what you need').fill(typed);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const turn = (await (await reply).json()) as { outcome: string; draft: unknown };
  expect(turn).toMatchObject({ outcome: 'FALLBACK_FORM', draft: null });

  // The assistant hides; the form says why and carries the typed words into the summary.
  await expect(page.getByRole('region', { name: 'Simple form' }).getByText(FALLBACK)).toBeVisible();
  await expect(page.getByLabel('Tell us what you need')).toBeHidden();
  const form = page.getByRole('form', { name: 'Request form' });
  await expect(form.getByLabel('Short summary')).toHaveValue(typed);
  await expect(page).toHaveTitle('Request help · SUAS');

  await form.getByLabel('What kind of help do you need?').selectOption('PEER_SUPPORT');
  await form.getByRole('button', { name: 'Send request' }).click();
  await expect(page).toHaveURL(/\/requests\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('region', { name: 'What you sent' })).toContainText(typed);
});

test('a server error from the assistant is explained and the form beside it still works', async ({
  browser,
  request,
  allow,
}) => {
  allow.push(/intake\/drafts :: 500/, /status of 500/);
  const page = await veteran(browser, request, { name: 'Rory Q.' });
  const typed = `Groceries for the week ${tag()}`;
  await page.route('**/api/v0/intake/drafts', (route) =>
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'boom' } }),
    }),
  );
  await page.goto('/request');
  await page.getByLabel('Tell us what you need').fill(typed);
  await page.getByRole('button', { name: 'Send', exact: true }).click();

  await expect(page.getByText(SEND_FAILED)).toBeVisible();
  // Nothing typed is lost; the raw server message is never shown.
  await expect(page.getByLabel('Tell us what you need')).toHaveValue(typed);
  await expect(page.getByText('boom')).toHaveCount(0);

  const form = page.getByRole('form', { name: 'Request form' });
  await form.getByLabel('What kind of help do you need?').selectOption('FOOD');
  await form.getByLabel('Short summary').fill(typed);
  await form.getByLabel('Where should the helper meet you?').fill('Library front steps');
  await form.getByRole('button', { name: 'Send request' }).click();
  await expect(page).toHaveURL(/\/requests\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('region', { name: 'What you sent' })).toContainText(typed);
});

test('if the assistant status cannot be read, the page offers the form alone', async ({
  browser,
  request,
  allow,
}) => {
  allow.push(/intake\/status :: 503/, /status of 503/);
  const page = await veteran(browser, request, { name: 'Rory Q.' });
  await page.route('**/api/v0/intake/status', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE', message: 'down' } }),
    }),
  );
  await page.goto('/request');
  // 5xx reads are retried before the page gives up on the assistant.
  await expect(page.getByRole('heading', { level: 1, name: 'Request help' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByLabel('Tell us what you need')).toHaveCount(0);
  await expect(
    page.getByText('The assistant is not available right now. The form works the same.'),
  ).toBeVisible();

  const summary = `Someone to talk to ${tag()}`;
  const form = page.getByRole('form', { name: 'Request form' });
  await form.getByLabel('What kind of help do you need?').selectOption('PEER_SUPPORT');
  await form.getByLabel('Short summary').fill(summary);
  await form.getByRole('button', { name: 'Send request' }).click();
  await expect(page).toHaveURL(/\/requests\/[0-9a-f-]{36}$/);
  const rows = await requestRows(page);
  await expect(rows).toHaveCount(1);
});
