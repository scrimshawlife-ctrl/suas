import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { API_URL } from './config';
import { newPerson, shoot, signInWithCode, uniqueEmail, withDb } from './helpers';

test('an admin saves a consent template version and publishes it; clients read it (R9.3)', async ({
  browser,
  request,
}) => {
  const templateKey = `e2e-consent-${uniqueEmail('k').slice(6, 14)}`;

  // The seeded admin signs in, then steps up with the test second factor.
  const admin = await newPerson(browser);
  await signInWithCode(admin, request, 'admin@example.invalid');
  await expect(admin).toHaveURL(/\/home$/);
  await admin.goto('/admin/consent-templates');
  await expect(admin).toHaveURL(/\/admin\/mfa$/);
  await admin.getByRole('button', { name: 'Start check' }).click();
  const hint = await admin.getByText(/This check id is/).textContent();
  const checkId = /This check id is ([^\s.]+)\./.exec(hint ?? '')?.[1];
  expect(checkId).toBeTruthy();
  await admin.getByLabel('Your response').fill(`ok-${checkId}`);
  await admin.getByRole('button', { name: 'Confirm' }).click();
  await expect(admin).toHaveURL(/\/admin\/consent-templates$/);

  await admin.getByLabel(/Template key/).fill(templateKey);
  await admin.getByLabel(/Template text/).fill('Synthetic test template for the e2e suite.');
  await admin.getByRole('button', { name: 'Save as draft' }).click();
  await expect(
    admin.getByText(`Saved ${templateKey}@1 as a draft.`, { exact: false }),
  ).toBeVisible();

  const results = await new AxeBuilder({ page: admin })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(
    results.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => v.id),
  ).toEqual([]);

  await admin.getByRole('button', { name: `Publish ${templateKey}@1` }).click();
  const dialog = admin.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Publish' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    admin
      .getByRole('listitem')
      .filter({ hasText: `${templateKey}@1` })
      .getByText('Published', { exact: true }),
  ).toBeVisible();
  await shoot(admin, '15-consent-templates');

  // Any signed-in client now reads the version a grant must cite.
  const token = await admin.evaluate(() => sessionStorage.getItem('suas.session') ?? '');
  const published = await request.get(`${API_URL}/api/v0/consent-templates/published`, {
    params: { purpose: templateKey },
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(await published.json()).toMatchObject({ version_key: `${templateKey}@1`, version: 1 });

  // The publish is audited.
  await expect
    .poll(() =>
      withDb(async (db) => {
        const rows = await db.query(
          `SELECT 1 FROM audit_events
            WHERE event_type = 'CONSENT_TEMPLATE_PUBLISHED' AND target_id = $1`,
          [`${templateKey}@1`],
        );
        return rows.rowCount;
      }),
    )
    .toBe(1);
});
