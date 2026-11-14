import { expect, test } from '../fixtures';
import { API_URL } from '../config';
import { signUp, uniqueEmail, withDb } from '../helpers';

/** R12.2 (contributor proposal, SUAS-specs #79): Settings changes the name and county. */
test('a person changes their display name and county in Settings, from either mode', async ({
  page,
  request,
}) => {
  await signUp(page, request, { email: uniqueEmail('settings'), name: 'Rae M.', county: 'Merced' });

  await page.getByRole('button', { name: 'Account and sign out for Rae' }).click();
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  const name = page.getByLabel('Name other veterans will see');
  const county = page.getByLabel('County');
  await expect(name).toHaveValue('Rae M.');
  await expect(county).toHaveValue('MERCED');

  // The Welcome validation applies.
  await name.fill('');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Enter the name other veterans will see.')).toBeVisible();

  await name.fill('Rachel M.');
  await county.selectOption({ label: 'Alameda' });
  await page.getByRole('button', { name: 'Save changes' }).click();
  // #293: the move of unaccepted requests is said before the new county is sent.
  const confirm = page.getByRole('dialog', { name: 'Change your county to Alameda?' });
  await expect(confirm).toContainText(
    'nobody has accepted yet will move to the Alameda County list',
  );
  await confirm.getByRole('button', { name: 'Change county' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Account and sign out for Rachel' })).toBeVisible();

  // The server holds the new values, and each change wrote its Audit Event (R9.5 a): one
  // from Welcome and one from Settings for each field.
  await page.reload();
  await expect(name).toHaveValue('Rachel M.');
  await expect(county).toHaveValue('ALAMEDA');
  const token = await page.evaluate(() => sessionStorage.getItem('suas.session') ?? '');
  const me = (await (
    await request.get(`${API_URL}/api/v0/veterans/me`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json()) as { user_id: string; display_name: string; county: string };
  expect(me).toMatchObject({ display_name: 'Rachel M.', county: 'ALAMEDA' });
  const events = await withDb(async (db) => {
    const rows = await db.query<{ event_type: string }>(
      `SELECT event_type FROM audit_events
        WHERE target_id = $1
          AND event_type IN ('USER_COUNTY_CHANGED', 'USER_DISPLAY_NAME_CHANGED')
        ORDER BY event_type`,
      [me.user_id],
    );
    return rows.rows.map((row) => row.event_type);
  });
  expect(events).toEqual([
    'USER_COUNTY_CHANGED',
    'USER_COUNTY_CHANGED',
    'USER_DISPLAY_NAME_CHANGED',
    'USER_DISPLAY_NAME_CHANGED',
  ]);

  // Serve mode reaches the same page from its avatar menu.
  await page.goto('/serve');
  await page.getByRole('button', { name: 'Account and sign out for Rachel' }).click();
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(name).toHaveValue('Rachel M.');
});
