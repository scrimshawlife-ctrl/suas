import { expect, test } from '@playwright/test';
import { draftTurns, passIdCheck, scriptModel, shoot, signUp, uniqueEmail } from './helpers';

test('a new Veteran signs up, passes the ID check and sends a request through the Intake Assistant', async ({
  page,
  request,
}) => {
  await signUp(page, request, {
    email: uniqueEmail('requester'),
    name: 'Marcus T.',
    county: 'Santa Clara',
  });
  await expect(page.getByRole('heading', { name: /Marcus/ })).toBeVisible();

  // Asking for help needs the scan: until then /request sends the person to /verify.
  await page.goto('/request');
  await expect(page).toHaveURL(/\/verify$/);
  await passIdCheck(page);
  // Continue returns to the page the person was heading for.
  await page.getByRole('link', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/request$/);

  // Home → "Request peer support" opens the one /request page.
  await page.getByRole('link', { name: /back to home/i }).click();
  await expect(page).toHaveURL(/\/home$/);
  await page.getByRole('link', { name: 'Request peer support' }).click();
  await expect(page).toHaveURL(/\/request\?category=PEER_SUPPORT$/);

  // One assistant turn: the scripted model drafts a FOOD request with no meeting place.
  const summary = `Groceries for the week ${uniqueEmail('x').slice(6, 14)}`;
  await scriptModel(request, draftTurns({ category: 'FOOD', summary, timing: 'Tomorrow morning' }));
  await page.getByLabel('Tell us what you need').fill('I could use some groceries this week.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Conversation' })).toContainText(
    'I drafted a request from what you wrote.',
  );

  // The draft card is editable; FOOD needs a meeting place before it can be sent.
  const card = page.getByRole('region', { name: 'Check your request' });
  await expect(card.getByLabel('Short summary')).toHaveValue(summary);
  await expect(card.getByLabel('What kind of help do you need?')).toHaveValue('FOOD');
  await card.getByRole('button', { name: 'Send request' }).click();
  await expect(card.getByText('Tell us where the helper should meet you.')).toBeVisible();
  await card.getByLabel('Where should the helper meet you?').fill('Front entrance of the library');
  await card.getByRole('button', { name: 'Send request' }).click();

  // The request page shows its status card; Home lists the request.
  await expect(page).toHaveURL(/\/requests\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('status').filter({ hasText: 'Request received' })).toBeVisible();
  await page.getByRole('link', { name: /back to home/i }).click();
  await expect(page).toHaveURL(/\/home$/);
  const row = page
    .getByRole('region', { name: 'Your requests' })
    .getByRole('link', { name: new RegExp(summary) });
  await expect(row).toContainText('Received');

  // Home's status card covers every category (me.active_qrf), so the FOOD request now
  // replaces the peer-support panel there.
  const status = page.getByRole('region', { name: 'Your food request' });
  await expect(status).toBeVisible();
  await expect(status.getByText('Your request has been received.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Request peer support' })).toHaveCount(0);
  await shoot(page, '01-request-home-status');
});
