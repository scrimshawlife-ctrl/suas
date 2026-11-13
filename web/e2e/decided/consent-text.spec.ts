import { expect, test } from '../fixtures';
import { API_URL } from '../config';
import { newPerson, newVerifiedVeteran, signUp, uniqueEmail, withDb } from '../helpers';

/** The synthetic RED-alert template text `seed-local` publishes (src/cli/seed-local.ts). */
const SEEDED_TEXT = 'Synthetic test template for the RED-alert notice — local development only.';

/** R12.3 (contributor proposal, SUAS-specs #79): the consent text is shown before the grant. */
test('turning on the RED alert shows the published consent text and grants only on confirm', async ({
  browser,
  request,
}) => {
  const veteran = await newVerifiedVeteran(browser, request, {
    name: 'Lee P.',
    county: 'Santa Clara',
    label: 'consent',
  });
  const page = veteran.page;

  // A trusted contact who has accepted, through the avatar menu's Invitations link (R12.4).
  await page.goto('/trusted-contacts');
  const contactEmail = uniqueEmail('brother');
  await page.getByLabel('Who is this to you?').fill('Brother');
  await page.getByLabel('Their email').fill(contactEmail);
  await page.getByRole('button', { name: 'Add trusted contact' }).click();
  await expect(page.getByText('Added. They are listed below.')).toBeVisible();
  const contact = await newPerson(browser);
  await signUp(contact, request, { email: contactEmail, name: 'Sam P.', county: 'Santa Clara' });
  const account = contact.getByRole('button', { name: 'Account and sign out for Sam' });
  await account.click();
  // The menu's own link: Home lists Invitations too.
  await contact
    .locator(`[id="${(await account.getAttribute('aria-controls')) ?? ''}"]`)
    .getByRole('link', { name: 'Invitations' })
    .click();
  await contact.getByRole('button', { name: 'Accept the invitation from Lee P.' }).click();
  await expect(contact.getByText('You have no invitations.')).toBeVisible();

  await page.reload();
  const listItem = page.getByRole('listitem').filter({ hasText: 'Brother' });
  await expect(listItem.getByText('Accepted')).toBeVisible();
  const toggle = listItem.getByRole('switch', { name: /Send this person a notice from SUAS/ });
  const grants = () =>
    withDb(async (db) => {
      const rows = await db.query<{ consent_template_version: string }>(
        `SELECT g.consent_template_version FROM consent_grants g
           JOIN users u ON u.user_id = g.veteran_user_id
          WHERE u.email = $1 AND g.scope = 'RED' AND g.status = 'ACTIVE'`,
        [veteran.email],
      );
      return rows.rows.map((row) => row.consent_template_version);
    });

  // Cancel: the text was shown and nothing was granted.
  await toggle.click();
  const dialog = page.getByRole('dialog', { name: 'Turn on this alert?' });
  await expect(dialog.getByText(SEEDED_TEXT)).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(toggle).not.toBeChecked();
  expect(await grants()).toEqual([]);

  // Turn on: one grant, citing the published version whose text was shown.
  await toggle.click();
  await dialog.getByRole('button', { name: 'Turn on' }).click();
  await expect(toggle).toBeChecked();
  await expect(listItem.getByText('On. The notice does not say why.')).toBeVisible();
  const token = await page.evaluate(() => sessionStorage.getItem('suas.session') ?? '');
  const published = (await (
    await request.get(`${API_URL}/api/v0/consent-templates/published`, {
      params: { purpose: 'red-alert-trusted-contact' },
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json()) as { version_key: string; body: string };
  expect(published.body).toBe(SEEDED_TEXT);
  expect(await grants()).toEqual([published.version_key]);
});
