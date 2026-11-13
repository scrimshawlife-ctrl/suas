import { randomInt } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { shoot, signUp, uniqueEmail } from './helpers';

/**
 * A synthetic person whose typed name matches the account name (VA_NAME_MISMATCH otherwise)
 * and whose name and birth date are unique, so no two tests share a VA identity.
 */
function syntheticVeteran() {
  const letters = Array.from({ length: 6 }, () => String.fromCharCode(97 + randomInt(26))).join('');
  return { first: 'Dana', last: `Vet${letters}`, year: String(1940 + randomInt(60)) };
}
type Veteran = ReturnType<typeof syntheticVeteran>;

/** Synthetic details only. The fixture adapter answers by ZIP (src/identity/va-confirmation-fixture.ts). */
async function fillDetails(page: Page, person: Veteran, zip: string): Promise<void> {
  await page.getByLabel('First name').fill(person.first);
  await page.getByLabel('Last name').fill(person.last);
  await page.getByLabel('Month').fill('1');
  await page.getByLabel('Day').fill('2');
  await page.getByLabel('Year').fill(person.year);
  await page.getByLabel('Street address').fill('1 Example Way');
  await page.getByLabel('City').fill('Exampleton');
  await page.getByLabel('State').selectOption('CA');
  await page.getByLabel('ZIP code').fill(zip);
}

async function signedUpOnVerify(
  page: Page,
  request: Parameters<typeof signUp>[1],
  label: string,
): Promise<Veteran> {
  const person = syntheticVeteran();
  await signUp(page, request, {
    email: uniqueEmail(label),
    name: `${person.first} ${person.last}`,
    county: 'Alameda',
  });
  // Asking for help needs a confirmation: /request sends the person to /verify.
  await page.goto('/request');
  await expect(page).toHaveURL(/\/verify$/);
  await expect(page.getByRole('heading', { name: 'Confirm your Veteran status' })).toBeVisible();
  return person;
}

const sendToVa = (page: Page) => page.getByRole('button', { name: 'Send to VA' }).click();

test('a Veteran reads the notice, corrects details VA could not match, is confirmed, and continues to /request', async ({
  page,
  request,
}) => {
  const person = await signedUpOnVerify(page, request, 'verify');
  await expect(page.getByRole('region', { name: 'Before you send anything to VA' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Tell us you served' })).toBeVisible();
  await shoot(page, 'verify-start');

  await fillDetails(page, person, '00002');
  const sent = page.waitForRequest(/\/verification\/va\/confirm$/);
  await sendToVa(page);
  expect((await sent).postDataJSON()).toMatchObject({ noticeVersion: 'va-notice-v1' });
  await expect(page.getByRole('heading', { name: "VA couldn't match your details" })).toBeFocused();
  // The form stays filled so the person can correct one field.
  await expect(page.getByLabel('Last name')).toHaveValue(person.last);
  await expect(page.getByLabel('ZIP code')).toHaveValue('00002');
  await shoot(page, 'verify-person-not-found');

  await page.getByLabel('ZIP code').fill('00001');
  await sendToVa(page);
  await expect(page.getByRole('heading', { name: /You're confirmed/ })).toBeVisible();
  await shoot(page, 'verify-verified');

  await page.getByRole('link', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/request$/);
});

test('VA not confirming status is not a finding; Serve and self-attestation stay open', async ({
  page,
  request,
}) => {
  const person = await signedUpOnVerify(page, request, 'verify-nt38');
  await fillDetails(page, person, '00003');
  await sendToVa(page);

  await expect(
    page.getByRole('heading', { name: 'VA did not confirm your Veteran status' }),
  ).toBeVisible();
  await expect(page.getByText(/This is not a finding that you never served\./)).toBeVisible();
  await expect(page.getByText('NOT_TITLE_38')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Go to Serve' })).toHaveAttribute('href', '/serve');
  await expect(page.getByRole('button', { name: 'Tell us you served' })).toBeVisible();
  await shoot(page, 'verify-not-title-38');
});

test('a VA outage is not counted and offers the crisis screen; a VA 400 is correctable', async ({
  page,
  request,
}) => {
  const person = await signedUpOnVerify(page, request, 'verify-outage');
  await fillDetails(page, person, '00005');
  await sendToVa(page);
  await expect(page.getByRole('heading', { name: "VA can't be reached right now" })).toBeVisible();
  await expect(page.getByText(/This didn't use one of your tries\./)).toBeVisible();
  await expect(page.getByRole('link', { name: 'More crisis options' })).toHaveAttribute(
    'href',
    '/crisis',
  );
  await expect(page.getByRole('link', { name: 'Go to Serve' })).toHaveAttribute('href', '/serve');
  await shoot(page, 'verify-unavailable');

  await page.getByRole('button', { name: 'Try again' }).click();
  await page.getByLabel('ZIP code').fill('00006');
  await sendToVa(page);
  await expect(
    page.getByRole('heading', { name: "We couldn't send your details to VA" }),
  ).toBeVisible();
  await expect(page.getByLabel('Last name')).toHaveValue(person.last);
  await shoot(page, 'verify-request-invalid');
});

test('a typed name that is not the account name is refused before VA', async ({
  page,
  request,
}) => {
  const person = await signedUpOnVerify(page, request, 'verify-name');
  await fillDetails(page, { ...person, first: 'Robin' }, '00001');
  await sendToVa(page);
  await expect(page.getByRole('heading', { name: 'Use the name on your account' })).toBeVisible();
  await expect(page.getByLabel('First name')).toHaveValue('Robin');
});

test('a Veteran who would rather not use VA tells us they served and continues to /request', async ({
  page,
  request,
}) => {
  await signedUpOnVerify(page, request, 'verify-self');
  await page.getByRole('button', { name: 'Tell us you served' }).click();
  await expect(page.getByRole('heading', { name: 'Tell us you served' })).toBeFocused();
  await expect(page.getByText('I am a Veteran of the U.S. armed forces.')).toBeVisible();
  await shoot(page, 'verify-self-attest');

  await page.getByRole('button', { name: 'Yes, I served' }).click();
  await expect(
    page.getByRole('heading', { name: 'Thanks. You can ask for help now.' }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/request$/);
});
