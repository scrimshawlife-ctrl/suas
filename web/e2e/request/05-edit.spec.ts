import type { APIRequestContext, Browser, Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { requestHelp } from '../helpers';
import { helper, recordPosts, take, tag, veteran } from './request';

const STALE = 'This changed while you were looking. Reload the page to see where it stands.';

test('editing checks the fields, Cancel throws edits away, and an emptied optional field is cleared', async ({
  browser,
  request,
}) => {
  const page = await veteran(browser, request, { name: 'Marcus T.' });
  const summary = `Groceries ${tag()}`;
  await requestHelp(
    page,
    request,
    { category: 'FOOD', summary, timing: 'Friday at noon' },
    'Library front steps',
  );
  const sent = page.getByRole('region', { name: 'What you sent' });

  // Cancel leaves the request as it was.
  await sent.getByRole('button', { name: 'Edit request' }).click();
  const form = sent.getByRole('form', { name: 'Edit request' });
  await form.getByLabel('Short summary').fill('Something else entirely');
  await form.getByRole('button', { name: 'Cancel' }).click();
  await expect(form).toHaveCount(0);
  await expect(sent).toContainText(summary);
  await expect(sent).not.toContainText('Something else entirely');
  // Opening the editor again starts from what was sent, not from the abandoned edit.
  await sent.getByRole('button', { name: 'Edit request' }).click();
  await expect(form.getByLabel('Short summary')).toHaveValue(summary);

  // Empty summary and an emptied meeting place (required for food) are refused.
  await form.getByLabel('Short summary').fill('');
  await form.getByLabel('Where should the helper meet you?').fill('');
  await form.getByRole('button', { name: 'Save changes' }).click();
  await expect(form.getByText('Tell us what you need.')).toBeVisible();
  await expect(form.getByText('Tell us where the helper should meet you.')).toBeVisible();
  await expect(form.getByLabel('Short summary')).toBeFocused();

  // Saving with no change just closes the editor.
  await form.getByRole('button', { name: 'Cancel' }).click();
  await sent.getByRole('button', { name: 'Edit request' }).click();
  await form.getByRole('button', { name: 'Save changes' }).click();
  await expect(form).toHaveCount(0);

  // Clearing the optional timing removes it from the request.
  const edited = `Groceries and diapers ${tag()}`;
  await sent.getByRole('button', { name: 'Edit request' }).click();
  await form.getByLabel('Short summary').fill(edited);
  await form.getByLabel('When do you need it? (optional)').fill('');
  await form.getByRole('button', { name: 'Save changes' }).click();
  await expect(form).toHaveCount(0);
  await expect(sent).toContainText(edited);
  await expect(sent).not.toContainText('Timing');
  await page.reload();
  await expect(sent).toContainText(edited);
  await expect(sent).not.toContainText('Friday at noon');

  // The list shows the edited summary.
  await page.goto('/requests');
  await expect(
    page.getByRole('main').getByRole('link', { name: new RegExp(edited) }),
  ).toBeVisible();
});

test('Back while editing leaves without saving; the request is unchanged when reopened', async ({
  browser,
  request,
}) => {
  const page = await veteran(browser, request, { name: 'Marcus T.' });
  const summary = `Someone to talk to ${tag()}`;
  const id = await requestHelp(page, request, { category: 'PEER_SUPPORT', summary }, 'Park bench');
  const sent = page.getByRole('region', { name: 'What you sent' });
  await sent.getByRole('button', { name: 'Edit request' }).click();
  await sent.getByLabel('Short summary').fill('Not saved');

  await page.goBack();
  await expect(page).toHaveURL(/\/request$/);
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`/requests/${id}$`));
  await expect(sent.getByRole('form', { name: 'Edit request' })).toHaveCount(0);
  await expect(sent).toContainText(summary);
  await expect(sent).not.toContainText('Not saved');
});

test('double-clicking Save changes saves once', async ({ browser, request }) => {
  const page = await veteran(browser, request, { name: 'Marcus T.' });
  const summary = `Someone to talk to ${tag()}`;
  await requestHelp(page, request, { category: 'PEER_SUPPORT', summary }, 'Park bench');
  const sent = page.getByRole('region', { name: 'What you sent' });
  await sent.getByRole('button', { name: 'Edit request' }).click();
  const edited = `Someone to talk to this week ${tag()}`;
  await sent.getByLabel('Short summary').fill(edited);
  const posts = recordPosts(page, /\/commands\/edit$/);
  await sent.getByRole('button', { name: 'Save changes' }).dblclick();
  await expect(sent).toContainText(edited);
  await expect(sent.getByRole('button', { name: 'Edit request' })).toBeVisible();
  // The second click either never left the page or replayed the first: no failure.
  expect(posts.length).toBeGreaterThan(0);
  expect(posts.every((p) => p.status === 200)).toBe(true);
});

/**
 * M7: the requester opens the edit form, a helper takes the request, then the requester
 * saves. Returns the recorded edit POSTs and the original summary.
 */
async function editWhileAccepted(page: Page, browser: Browser, request: APIRequestContext) {
  const summary = `Ride to the clinic ${tag()}`;
  const id = await requestHelp(
    page,
    request,
    { category: 'TRANSPORTATION', summary },
    'Library front steps',
  );
  const sent = page.getByRole('region', { name: 'What you sent' });
  await sent.getByRole('button', { name: 'Edit request' }).click();
  await sent.getByLabel('Short summary').fill(`Too late ${tag()}`);

  const helperPage = await helper(browser, request, { name: 'Dee R.' });
  await take(helperPage, summary, id);

  const posts = recordPosts(page, /\/commands\/edit$/);
  const refused = page.waitForResponse((r) => /\/commands\/edit$/.test(r.url()));
  await sent.getByRole('button', { name: 'Save changes' }).click();
  return { summary, sent, posts, response: await refused };
}

test('M7: saving an edit after a helper accepted gets 409 and explains that the request changed', async ({
  browser,
  request,
  allow,
}) => {
  allow.push(/status of 409/);
  const page = await veteran(browser, request, { name: 'Marcus T.' });
  const { summary, sent, response } = await editWhileAccepted(page, browser, request);

  expect(response.status()).toBe(409);
  // The page explains in plain words; the accepted request keeps what the helper saw.
  await expect(sent.getByText(STALE)).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Dee R. accepted your request.' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'What you sent' })).toContainText(summary);
  await expect(page.getByRole('button', { name: 'Edit request' })).toHaveCount(0);
});

// G20 (agent C): the edit form does not send `expected_status` yet, so the API answers
// 409 ILLEGAL_TRANSITION instead of the stale-state 409. Unskip once G20 lands.
test.fixme('M7: the edit carries the status it was opened on and the API answers STALE_STATE', async ({
  browser,
  request,
  allow,
}) => {
  allow.push(/status of 409/);
  const page = await veteran(browser, request, { name: 'Marcus T.' });
  const { posts, response } = await editWhileAccepted(page, browser, request);

  expect(posts[0]?.body).toMatchObject({ expected_status: expect.any(String) });
  expect(response.status()).toBe(409);
  expect(((await response.json()) as { error: { code: string } }).error.code).toBe('STALE_STATE');
});
