/**
 * Setup for the multi-user flows that need a trusted contact: the Veteran invites, the contact
 * accepts, the Veteran turns on the RED notice, and a RED Check-In sends it (as 04-red-alert).
 */

import { expect, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { newPerson, newVerifiedVeteran, signUp, uniqueEmail } from '../helpers';

/** A Veteran and a trusted contact who accepted, with the RED notice on. Both in Santa Clara. */
export async function veteranWithRedContact(
  browser: Browser,
  request: APIRequestContext,
): Promise<{ veteran: Page; contact: Page }> {
  const { page: veteran } = await newVerifiedVeteran(browser, request, {
    name: 'Marcus T.',
    county: 'Santa Clara',
    label: 'm-red',
  });
  await veteran.goto('/trusted-contacts');
  const contactEmail = uniqueEmail('m-sister');
  await veteran.getByLabel('Who is this to you?').fill('Sister');
  await veteran.getByLabel('Their email').fill(contactEmail);
  await veteran.getByRole('button', { name: 'Add trusted contact' }).click();
  await expect(veteran.getByText('Added. They are listed below.')).toBeVisible();

  const contact = await newPerson(browser);
  await signUp(contact, request, { email: contactEmail, name: 'Ann T.', county: 'Santa Clara' });
  await contact.goto('/invitations');
  await contact.getByRole('button', { name: 'Accept the invitation from Marcus T.' }).click();
  await expect(contact.getByText('You have no invitations.')).toBeVisible();

  await veteran.reload();
  const row = veteran.getByRole('listitem').filter({ hasText: 'Sister' });
  await expect(row.getByText('Accepted')).toBeVisible();
  const notice = row.getByRole('switch', { name: /Send this person a notice from SUAS/ });
  await notice.click();
  await expect(notice).toBeChecked();
  return { veteran, contact };
}

/** A Check-In answered "No; I need immediate help" wherever it is offered: a RED result. */
export async function redCheckIn(veteran: Page): Promise<void> {
  await veteran.goto('/home');
  await veteran.getByRole('link', { name: 'Start Check-In' }).click();
  const done = veteran.getByRole('heading', { name: 'Thank you for checking in.' });
  for (let n = 1; ; n += 1) {
    await expect(
      veteran.getByText(new RegExp(`^Question ${String(n)} of \\d+$`)).or(done),
    ).toBeVisible();
    if (await done.isVisible()) break;
    const urgent = veteran.getByRole('radio', { name: 'No; I need immediate help' });
    if (await urgent.count()) await urgent.check();
    else await veteran.getByRole('radio').first().check();
    await veteran.getByRole('button', { name: 'Save answer' }).click();
  }
}
