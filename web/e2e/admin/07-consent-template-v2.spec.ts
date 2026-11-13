import type { Locator } from '@playwright/test';
import { expect, test } from '../fixtures';
import { newPerson, newVerifiedVeteran, signUp, uniqueEmail } from '../helpers';
import { errorCode, nextResponse } from '../auth/auth';
import { elevatedAdmin } from './admin';

const TEMPLATE_KEY = 'red-alert-trusted-contact';
const CONSENTS = /\/api\/v0\/consents$/;

/** Flips the switch and confirms the consent text dialog (R12.3). */
async function turnOn(toggle: Locator): Promise<void> {
  await toggle.click();
  await toggle
    .page()
    .getByRole('dialog', { name: 'Turn on this alert?' })
    .getByRole('button', { name: 'Turn on' })
    .click();
}

// M2: the Veteran's page read the published RED-alert template (v1, from seed-local) before an
// admin published the next version. Turning the alert on cites the superseded version, which
// the API refuses (422, documented by R12.8); the page re-reads the template and the next try
// cites the new one.
test('an admin publishes the next consent version while a Veteran is on the page; the grant cites it', async ({
  browser,
  request,
  allow,
}) => {
  // Provoked on purpose: the superseded version is refused.
  allow.push(/status of 422/);
  const veteran = await newVerifiedVeteran(browser, request, {
    name: 'Nia R.',
    county: 'Alameda',
    label: 'm2-vet',
  });
  const page = veteran.page;
  await page.goto('/trusted-contacts');
  const contactEmail = uniqueEmail('m2-brother');
  await page.getByLabel('Who is this to you?').fill('Brother');
  await page.getByLabel('Their email').fill(contactEmail);
  await page.getByRole('button', { name: 'Add trusted contact' }).click();
  await expect(page.getByText('Added. They are listed below.')).toBeVisible();

  const contact = await newPerson(browser);
  await signUp(contact, request, { email: contactEmail, name: 'Ben R.', county: 'Alameda' });
  await contact.goto('/invitations');
  await contact.getByRole('button', { name: 'Accept the invitation from Nia R.' }).click();
  await expect(
    contact.getByText('Accepted. They can now choose what SUAS may tell you.'),
  ).toBeVisible();

  // The Veteran's page now holds the published template it read on load.
  await page.reload();
  const item = page.getByRole('listitem').filter({ hasText: 'Brother' });
  await expect(item.getByText('Accepted')).toBeVisible();
  const toggle = item.getByRole('switch', { name: /Send this person a notice from SUAS/ });
  await expect(toggle).not.toBeChecked();

  // The admin writes and publishes the next version of the same key.
  const admin = await elevatedAdmin(browser, request);
  await admin.goto('/admin/consent-templates');
  await admin.getByLabel(/Template key/).fill(TEMPLATE_KEY);
  await admin.getByLabel(/Template text/).fill('Synthetic RED-alert consent text, next version.');
  await admin.getByRole('button', { name: 'Save as draft' }).click();
  const saved = admin.getByText(/^Saved red-alert-trusted-contact@\d+ as a draft\./);
  await expect(saved).toBeVisible();
  const versionKey = /(red-alert-trusted-contact@\d+)/.exec((await saved.textContent()) ?? '')?.[1];
  expect(versionKey).toBeTruthy();
  expect(versionKey).not.toBe(`${TEMPLATE_KEY}@1`);
  await admin.getByRole('button', { name: `Publish ${versionKey ?? ''}` }).click();
  await admin.getByRole('dialog').getByRole('button', { name: 'Publish' }).click();
  await expect(admin.getByRole('dialog')).toHaveCount(0);

  // First try: the page still cites v1, which is superseded now.
  let answer = nextResponse(page, 'POST', CONSENTS);
  const reread = nextResponse(page, 'GET', /\/api\/v0\/consent-templates\/published$/);
  await turnOn(toggle);
  const refused = await answer;
  expect(refused.status()).toBe(422);
  expect(await errorCode(refused)).toBe('CONSENT_TEMPLATE_UNAVAILABLE');
  expect(refused.request().postDataJSON()).toMatchObject({
    consent_template_version: `${TEMPLATE_KEY}@1`,
  });
  await expect(toggle).not.toBeChecked();
  await expect(item.getByRole('alert')).toBeVisible();

  expect((await reread).ok()).toBe(true);
  // The page re-read the template; the next try cites the new version and turns the alert on.
  answer = nextResponse(page, 'POST', CONSENTS);
  await turnOn(toggle);
  const granted = await answer;
  // Regression: the retry used to reuse the first Idempotency-Key and got 409.
  expect(granted.status(), await granted.text()).toBe(201);
  expect(await granted.json()).toMatchObject({ consent_template_version: versionKey });
  await expect(toggle).toBeChecked();
  await expect(item.getByText('On. The notice does not say why.')).toBeVisible();
});
