import { expect, test } from '../fixtures';
import { draftTurns, scriptModel } from '../helpers';
import { idFromUrl, requestRows, tag, veteran } from './request';

type Category = Parameters<typeof draftTurns>[0]['category'];

// FOOD through the assistant (and its missing meeting place) is covered by 01-request.spec.ts.
const CASES: { category: Category; label: string; needsPlace: boolean }[] = [
  { category: 'TRANSPORTATION', label: 'Transportation', needsPlace: true },
  { category: 'SHELTER', label: 'Housing', needsPlace: true },
  { category: 'PEER_SUPPORT', label: 'Peer support', needsPlace: false },
];

for (const { category, label, needsPlace } of CASES) {
  test(`the Intake Assistant drafts a ${label} request and the Veteran sends it from the draft card`, async ({
    browser,
    request,
  }) => {
    const page = await veteran(browser, request, { name: 'Rory Q.' });
    const summary = `${label} help ${tag()}`;

    await page.goto('/request');
    await expect(page).toHaveTitle('Request help · SUAS');
    await scriptModel(request, draftTurns({ category, summary, timing: 'Tomorrow at 10 am' }));
    await page.getByLabel('Tell us what you need').fill(`I need ${label.toLowerCase()} help.`);
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    const conversation = page.getByRole('list', { name: 'Conversation' });
    await expect(conversation).toContainText(`I need ${label.toLowerCase()} help.`);
    await expect(conversation).toContainText('I drafted a request from what you wrote.');
    // What was typed is cleared once the assistant answered.
    await expect(page.getByLabel('Tell us what you need')).toHaveValue('');

    const card = page.getByRole('region', { name: 'Check your request' });
    await expect(card.getByLabel('What kind of help do you need?')).toHaveValue(category);
    await expect(card.getByLabel('Short summary')).toHaveValue(summary);
    await expect(card.getByLabel('When do you need it? (optional)')).toHaveValue(
      'Tomorrow at 10 am',
    );
    await expect(card.getByLabel(/Where are you going/)).toHaveCount(
      category === 'TRANSPORTATION' ? 1 : 0,
    );

    if (needsPlace) {
      // The meeting place is required for this kind of help: Send request says so.
      await card.getByRole('button', { name: 'Send request' }).click();
      await expect(card.getByText('Tell us where the helper should meet you.')).toBeVisible();
      await expect(card.getByLabel('Where should the helper meet you?')).toBeFocused();
      await expect(page).toHaveURL(/\/request$/);
      await card.getByLabel('Where should the helper meet you?').fill('Library front steps');
    }
    if (category === 'TRANSPORTATION') {
      await card.getByLabel(/Where are you going/).fill('Clinic on First Street');
    }
    await card.getByRole('button', { name: 'Send request' }).click();

    await expect(page).toHaveURL(/\/requests\/[0-9a-f-]{36}$/);
    await expect(page).toHaveTitle('Your request · SUAS');
    await expect(page.getByRole('status').filter({ hasText: 'Request received' })).toBeVisible();
    const sent = page.getByRole('region', { name: 'What you sent' });
    await expect(sent).toContainText(label);
    await expect(sent).toContainText(summary);
    await expect(sent).toContainText('Tomorrow at 10 am');
    if (needsPlace) await expect(sent).toContainText('Library front steps');
    if (category === 'TRANSPORTATION') await expect(sent).toContainText('Clinic on First Street');

    // Exactly one request exists.
    const rows = await requestRows(page);
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(summary);
  });
}

test('a question first, then a follow-up on the same draft: the second message drafts the request', async ({
  browser,
  request,
}) => {
  const page = await veteran(browser, request, { name: 'Rory Q.' });
  const summary = `Someone to talk to ${tag()}`;
  // Turn 1 only asks a question (NO_DRAFT); turn 2 drafts the request on the same draft.
  await scriptModel(request, [
    { ok: true, text: 'What kind of help would be most useful?', toolCalls: [] },
    ...draftTurns({ category: 'PEER_SUPPORT', summary }),
  ]);
  const created = page.waitForResponse(
    (r) => r.request().method() === 'POST' && /\/api\/v0\/intake\/drafts$/.test(r.url()),
  );
  await page.goto('/request');
  await page.getByLabel('Tell us what you need').fill('I am having a hard week.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const first = await created;
  expect(first.status()).toBe(201);
  const draftId = ((await first.json()) as { draft: { draft_id: string } }).draft.draft_id;

  const conversation = page.getByRole('list', { name: 'Conversation' });
  await expect(conversation).toContainText('What kind of help would be most useful?');
  await expect(page.getByRole('region', { name: 'Check your request' })).toHaveCount(0);

  const followUp = page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' && r.url().endsWith(`/intake/drafts/${draftId}/messages`),
  );
  await page.getByLabel('Tell us what you need').fill('Someone to talk to, please.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  expect((await followUp).status()).toBe(200);
  await expect(conversation.getByRole('listitem')).toHaveCount(2);
  await expect(conversation).toContainText('I drafted a request from what you wrote.');

  const card = page.getByRole('region', { name: 'Check your request' });
  await expect(card.getByLabel('Short summary')).toHaveValue(summary);
  await card.getByRole('button', { name: 'Send request' }).click();
  await expect(page).toHaveURL(/\/requests\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('region', { name: 'What you sent' })).toContainText(summary);
});

test('a draft field is saved with PATCH when it loses focus', async ({ browser, request }) => {
  const page = await veteran(browser, request, { name: 'Rory Q.' });
  await scriptModel(request, draftTurns({ category: 'FOOD', summary: `Groceries ${tag()}` }));
  await page.goto('/request');
  await page.getByLabel('Tell us what you need').fill('I need food.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const card = page.getByRole('region', { name: 'Check your request' });

  const patched = page.waitForResponse((r) => r.request().method() === 'PATCH');
  await card.getByLabel('Where should the helper meet you?').fill('Corner of Elm and Oak');
  await card.getByLabel('Short summary').focus();
  const response = await patched;
  expect(response.url()).toMatch(/\/api\/v0\/intake\/drafts\/[0-9a-f-]{36}$/);
  expect(response.status()).toBe(200);
  // Only the changed field is sent, and the server holds it from now on.
  expect(response.request().postDataJSON()).toEqual({ meeting_place: 'Corner of Elm and Oak' });
  expect(((await response.json()) as { meeting_place: string }).meeting_place).toBe(
    'Corner of Elm and Oak',
  );

  // Send request has nothing left to save, so it submits without another PATCH.
  let laterPatches = 0;
  page.on('request', (r) => {
    if (r.method() === 'PATCH') laterPatches += 1;
  });
  await card.getByRole('button', { name: 'Send request' }).click();
  await expect(page).toHaveURL(/\/requests\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('region', { name: 'What you sent' })).toContainText(
    'Corner of Elm and Oak',
  );
  expect(laterPatches).toBe(0);
});

test('edits on the draft card (kind of help, summary, timing, place) are what gets sent', async ({
  browser,
  request,
}) => {
  const page = await veteran(browser, request, { name: 'Rory Q.' });
  const summary = `Ride to the clinic ${tag()}`;
  const edited = `Someone to talk to ${tag()}`;
  await scriptModel(request, draftTurns({ category: 'TRANSPORTATION', summary }));
  await page.goto('/request');
  await page.getByLabel('Tell us what you need').fill('I need a ride.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();

  const card = page.getByRole('region', { name: 'Check your request' });
  await card.getByLabel(/Where are you going/).fill('Clinic on First Street');
  // Switching away from a ride drops the destination and the meeting place becomes optional.
  await card.getByLabel('What kind of help do you need?').selectOption('PEER_SUPPORT');
  await expect(card.getByLabel(/Where are you going/)).toHaveCount(0);
  await expect(card.getByText(/^Optional\. Only you and the person/)).toBeVisible();
  await card.getByLabel('Short summary').fill(edited);
  await card.getByLabel('When do you need it? (optional)').fill('This evening');
  await card.getByRole('button', { name: 'Send request' }).click();

  await expect(page).toHaveURL(/\/requests\/[0-9a-f-]{36}$/);
  const sent = page.getByRole('region', { name: 'What you sent' });
  await expect(sent).toContainText('Peer support');
  await expect(sent).toContainText(edited);
  await expect(sent).toContainText('This evening');
  await expect(sent).not.toContainText(summary);
  await expect(sent).not.toContainText('Going to');
});

test('a follow-up message keeps the edits made on the draft card', async ({ browser, request }) => {
  const page = await veteran(browser, request, { name: 'Rory Q.' });
  const summary = `Groceries ${tag()}`;
  await scriptModel(request, [
    ...draftTurns({ category: 'FOOD', summary }),
    { ok: true, text: 'Thanks, I added that.', toolCalls: [] },
  ]);
  await page.goto('/request');
  await page.getByLabel('Tell us what you need').fill('I need food.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const card = page.getByRole('region', { name: 'Check your request' });
  await card.getByLabel('Where should the helper meet you?').fill('Corner of Elm and Oak');

  await page.getByLabel('Tell us what you need').fill('Also some baby formula.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Conversation' })).toContainText(
    'Thanks, I added that.',
  );
  await expect(card.getByLabel('Where should the helper meet you?')).toHaveValue(
    'Corner of Elm and Oak',
  );
  await card.getByRole('button', { name: 'Send request' }).click();
  await expect(page).toHaveURL(/\/requests\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('region', { name: 'What you sent' })).toContainText(
    'Corner of Elm and Oak',
  );
});

test('double-clicking Send request on the draft card makes one request', async ({
  browser,
  request,
}) => {
  const page = await veteran(browser, request, { name: 'Rory Q.' });
  await scriptModel(request, draftTurns({ category: 'PEER_SUPPORT', summary: `Talk ${tag()}` }));
  await page.goto('/request');
  await page.getByLabel('Tell us what you need').fill('I want to talk to someone.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const card = page.getByRole('region', { name: 'Check your request' });
  await card.getByRole('button', { name: 'Send request' }).dblclick();
  await expect(page).toHaveURL(/\/requests\/[0-9a-f-]{36}$/);
  const first = idFromUrl(page);

  const rows = await requestRows(page);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute('href', `/requests/${first}`);
});

test('Back after sending does not resend or show the sent draft as new; Forward returns', async ({
  browser,
  request,
}) => {
  const page = await veteran(browser, request, { name: 'Rory Q.' });
  const summary = `Someone to talk to ${tag()}`;
  await scriptModel(request, draftTurns({ category: 'PEER_SUPPORT', summary }));
  await page.goto('/request');
  await page.getByLabel('Tell us what you need').fill('I want to talk to someone.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page
    .getByRole('region', { name: 'Check your request' })
    .getByRole('button', { name: 'Send request' })
    .click();
  await expect(page).toHaveURL(/\/requests\/[0-9a-f-]{36}$/);
  const id = idFromUrl(page);

  await page.goBack();
  await expect(page).toHaveURL(/\/request$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Request help' })).toBeVisible();
  // A fresh page: no conversation and no half-filled draft from the request already sent.
  await expect(page.getByRole('region', { name: 'Check your request' })).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'Conversation' })).toHaveCount(0);
  await expect(page.getByLabel('Tell us what you need')).toHaveValue('');

  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`/requests/${id}$`));
  await expect(page.getByRole('region', { name: 'What you sent' })).toContainText(summary);

  const rows = await requestRows(page);
  await expect(rows).toHaveCount(1);
});
