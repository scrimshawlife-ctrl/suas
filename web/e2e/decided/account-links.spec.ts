import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { newPerson, signInWithCode, signUp, uniqueEmail } from '../helpers';

/** Opens the avatar menu and returns its panel (Home has its own Invitations link). */
async function openAccountMenu(page: Page) {
  const trigger = page.getByRole('button', { name: /^Account and sign out for / });
  await trigger.click();
  return page.locator(`[id="${(await trigger.getAttribute('aria-controls')) ?? ''}"]`);
}

/** R12.4 (contributor proposal, SUAS-specs #79): avatar menu links and "Back to SUAS". */
test('the avatar menu links Settings and Invitations for everyone, and Admin console for an admin', async ({
  browser,
  request,
}) => {
  // A person who is not an admin: no Admin console link, in either mode.
  const person = await newPerson(browser);
  await signUp(person, request, { email: uniqueEmail('links'), name: 'Jo K.', county: 'Merced' });
  for (const home of ['/home', '/serve']) {
    await person.goto(home);
    const menu = await openAccountMenu(person);
    await expect(menu.getByRole('link', { name: 'Settings' })).toBeVisible();
    await expect(menu.getByRole('link', { name: 'Invitations' })).toBeVisible();
    await expect(menu.getByRole('link', { name: 'Admin console' })).toHaveCount(0);
    await person.keyboard.press('Escape');
  }
  await (await openAccountMenu(person)).getByRole('link', { name: 'Invitations' }).click();
  await expect(person).toHaveURL(/\/invitations$/);

  // The seeded admin: Admin console, the MFA step-up, then Back to SUAS goes Home.
  const admin = await newPerson(browser);
  await signInWithCode(admin, request, 'admin@example.invalid');
  await expect(admin).toHaveURL(/\/home$/);
  await (await openAccountMenu(admin)).getByRole('link', { name: 'Admin console' }).click();
  await expect(admin).toHaveURL(/\/admin\/mfa$/);
  await admin.getByRole('button', { name: 'Start check' }).click();
  const hint = await admin.getByText(/This check id is/).textContent();
  const checkId = /This check id is ([^\s.]+)\./.exec(hint ?? '')?.[1];
  expect(checkId).toBeTruthy();
  await admin.getByLabel('Your response').fill(`ok-${checkId}`);
  await admin.getByRole('button', { name: 'Confirm' }).click();
  await expect(admin).toHaveURL(/\/admin$/);
  await expect(admin.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();

  await admin.getByRole('link', { name: 'Back to SUAS' }).click();
  await expect(admin).toHaveURL(/\/home$/);
  await expect(admin.getByRole('heading', { level: 1 })).toBeVisible();
});
