import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { API_URL } from './config';
import { newPerson, newVerifiedVeteran, shoot, signUp, uniqueEmail, withDb } from './helpers';

const sessionToken = (page: Page) =>
  page.evaluate(() => sessionStorage.getItem('suas.session') ?? '');

test('a RED Check-In alerts the trusted contact who holds a RED grant', async ({
  browser,
  request,
}) => {
  const veteran = await newVerifiedVeteran(browser, request, {
    name: 'Marcus T.',
    county: 'Santa Clara',
    label: 'checkin',
  });
  const page = veteran.page;

  // The Veteran adds a trusted contact; SUAS emails the invitation (R9.4).
  await page.goto('/trusted-contacts');
  const contactEmail = uniqueEmail('sister');
  await page.getByLabel('Who is this to you?').fill('Sister');
  await page.getByLabel('Their email').fill(contactEmail);
  await page.getByRole('button', { name: 'Add trusted contact' }).click();
  await expect(page.getByText('Added. They are listed below.')).toBeVisible();
  await expect
    .poll(async () =>
      withDb(async (db) => {
        const rows = await db.query<{ template_version: string }>(
          `SELECT template_version FROM notifications
            WHERE reason = 'trusted_contact_invited' AND destination = $1`,
          [contactEmail],
        );
        return rows.rows.map((row) => row.template_version);
      }),
    )
    .toEqual(['invite@1']);

  // The contact signs up with that address and accepts on the Invitations page, which shows
  // the Veteran's display name and the relationship only.
  const contact = await newPerson(browser);
  await signUp(contact, request, { email: contactEmail, name: 'Ann T.', county: 'Santa Clara' });
  await contact.getByRole('link', { name: 'Invitations' }).click();
  await expect(contact).toHaveURL(/\/invitations$/);
  await expect(contact.getByText('Marcus T.')).toBeVisible();
  await expect(contact.getByText('They listed you as: Sister')).toBeVisible();
  await shoot(contact, '04-invitation');
  await contact.getByRole('button', { name: 'Accept the invitation from Marcus T.' }).click();
  await expect(
    contact.getByText('Accepted. They can now choose what SUAS may tell you.'),
  ).toBeVisible();
  await expect(contact.getByText('You have no invitations.')).toBeVisible();
  const veteranAuth = { Authorization: `Bearer ${await sessionToken(page)}` };
  const circle = await request.get(`${API_URL}/api/v0/trusted-contacts`, { headers: veteranAuth });
  const trustedContactId = (
    (await circle.json()) as { trusted_contacts: { trusted_contact_id: string }[] }
  ).trusted_contacts[0]?.trusted_contact_id;
  expect(trustedContactId).toBeTruthy();

  // Back in the UI: the contact is Accepted and the Veteran turns on the RED notice.
  await page.reload();
  const listItem = page.getByRole('listitem').filter({ hasText: 'Sister' });
  await expect(listItem.getByText('Accepted')).toBeVisible();
  // The switch is controlled: it turns on once the grant is saved, after the Veteran reads
  // the consent text and confirms (R12.3), so click, confirm, then wait.
  const notice = listItem.getByRole('switch', { name: /Send this person a notice from SUAS/ });
  await notice.click();
  await page
    .getByRole('dialog', { name: 'Turn on this alert?' })
    .getByRole('button', { name: 'Turn on' })
    .click();
  await expect(notice).toBeChecked();
  await expect(listItem.getByText('On. The notice does not say why.')).toBeVisible();

  // A Check-In with "No; I need immediate help" is a RED result.
  await page.goto('/home');
  await page.getByRole('link', { name: 'Start Check-In' }).click();
  const done = page.getByRole('heading', { name: 'Thank you for checking in.' });
  for (let n = 1; ; n += 1) {
    await expect(
      page.getByText(new RegExp(`^Question ${String(n)} of \\d+$`)).or(done),
    ).toBeVisible();
    if (await done.isVisible()) break;
    const urgent = page.getByRole('radio', { name: 'No; I need immediate help' });
    if (await urgent.count()) await urgent.check();
    else await page.getByRole('radio').first().check();
    await page.getByRole('button', { name: 'Save answer' }).click();
  }

  // The UI says nothing about the alert. It shows the crisis resources, as buttons.
  await expect(page.getByText('Your answers are saved.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Call 911' }).first()).toHaveAttribute(
    'href',
    'tel:911',
  );
  await expect(page.getByRole('link', { name: 'Call or text 988' }).first()).toHaveAttribute(
    'href',
    'tel:988',
  );
  await expect(page.getByText(/trusted contact|alert/i)).toHaveCount(0);
  await shoot(page, '04-red-check-in-result');

  // The alert is recorded: one EMAIL notification to the contact, SENT, and the audit event.
  const contactId = (
    (await (
      await request.get(`${API_URL}/api/v0/veterans/me`, {
        headers: { Authorization: `Bearer ${await sessionToken(contact)}` },
      })
    ).json()) as { user_id: string }
  ).user_id;
  await expect
    .poll(async () =>
      withDb(async (db) => {
        const rows = await db.query<{ channel: string; delivery_status: string }>(
          `SELECT channel, delivery_status FROM notifications
            WHERE reason = 'trusted_contact_alert' AND recipient_user_id = $1`,
          [contactId],
        );
        return rows.rows.map((row) => `${row.channel}:${row.delivery_status}`);
      }),
    )
    .toEqual(['EMAIL:SENT']);
  await expect
    .poll(async () =>
      withDb(async (db) => {
        const rows = await db.query(
          `SELECT 1 FROM domain_events
            WHERE event_type = 'TRUSTED_CONTACT_ALERTED' AND aggregate_id = $1`,
          [trustedContactId],
        );
        return rows.rowCount;
      }),
    )
    .toBe(1);

  // The contact sees the notice, which does not describe the Veteran's situation.
  await contact.goto('/notifications');
  await expect(
    contact.getByText(
      /Someone who named you as a trusted contact asked SUAS to send you this notice/,
    ),
  ).toBeVisible();
});
