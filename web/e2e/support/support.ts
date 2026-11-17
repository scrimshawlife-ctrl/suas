/**
 * Steps shared by the support, cross and time scenarios: closing the people a test opened, the
 * trusted-contact form, the Check-In driver and the crisis chrome.
 */

import {
  expect,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { newPerson, signUp, uniqueEmail } from '../helpers';
import { newVeteran, type Person } from '../people';

/**
 * Closes every context the test opened besides its own, before the fixture's checks. Each spec
 * file that uses it runs it after every test.
 */
export async function closePeople({
  browser,
  context,
}: {
  browser: Browser;
  context: BrowserContext;
}): Promise<void> {
  await Promise.all(
    browser
      .contexts()
      .filter((opened) => opened !== context)
      .map((opened) => opened.close()),
  );
}

/** R12.3: turning the RED alert on is confirmed in the consent text dialog. */
export async function confirmAlert(page: Page): Promise<void> {
  await page
    .getByRole('dialog', { name: 'Turn on this alert?' })
    .getByRole('button', { name: 'Turn on' })
    .click();
}

/** A 5xx in the API's error envelope, for the `page.route` failures the real stack cannot give. */
export function serverError(status = 500) {
  const code = status === 503 ? 'SERVICE_UNAVAILABLE' : 'INTERNAL_ERROR';
  return {
    status,
    contentType: 'application/json',
    body: JSON.stringify({ error: { code, message: 'Unexpected internal failure.' } }),
  };
}

/** The crisis band and footer (SAFETY_COPY.md §2.2, §2.3), each with real call/text targets. */
export async function expectCrisisChrome(page: Page): Promise<void> {
  for (const region of [
    page.getByRole('complementary', { name: 'Crisis support' }),
    page.getByRole('contentinfo'),
  ]) {
    await expect(region.getByRole('link', { name: 'Call 911' })).toHaveAttribute('href', 'tel:911');
    await expect(region.getByRole('link', { name: 'Call 988' })).toHaveAttribute('href', 'tel:988');
    await expect(region.getByRole('link', { name: 'Text 988' })).toHaveAttribute('href', 'sms:988');
    await expect(
      region.getByRole('link', { name: 'Veterans Crisis Line: Text 838255' }),
    ).toHaveAttribute('href', 'sms:838255');
  }
}

// --- Trusted contacts -------------------------------------------------------------------

export const ALERT_SWITCH = /Send this person a notice from SUAS/;

/**
 * On /trusted-contacts: fills the form, adds the person and waits until the form has cleared
 * (the success line stays from an earlier add, so it alone does not prove this one). Returns
 * the API status: 201 for a new invite, 200 for one this Veteran already sent.
 */
export async function invite(page: Page, label: string, email: string): Promise<number> {
  const posted = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith('/api/v0/trusted-contacts'),
  );
  await page.getByLabel('Who is this to you?').fill(label);
  await page.getByLabel('Their email').fill(email);
  await page.getByRole('button', { name: 'Add trusted contact' }).click();
  const response = await posted;
  expect(response.ok(), `invite ${label}`).toBe(true);
  await expect(page.getByLabel('Who is this to you?')).toHaveValue('');
  await expect(page.getByText('Added. They are listed below.')).toBeVisible();
  return response.status();
}

export function contactRow(page: Page, label: string) {
  return page
    .getByRole('region', { name: 'Your trusted contacts' })
    .getByRole('listitem')
    .filter({ has: page.getByText(label, { exact: true }) });
}

/** The invitee signs up with the invited address and accepts on /invitations. */
async function acceptInvite(
  browser: Browser,
  request: APIRequestContext,
  email: string,
  from: string,
): Promise<Page> {
  const page = await newPerson(browser);
  await signUp(page, request, { email, name: 'Ann T.', county: 'Santa Clara' });
  await page.goto('/invitations');
  await page.getByRole('button', { name: `Accept the invitation from ${from}` }).click();
  await expect(
    page.getByText('Accepted. They can now choose what SUAS may tell you.'),
  ).toBeVisible();
  return page;
}

/** A Veteran with one accepted contact whose RED notice is on, left on /trusted-contacts. */
export async function veteranWithNotice(
  browser: Browser,
  request: APIRequestContext,
  label: string,
): Promise<Person> {
  const vet = await newVeteran(browser, request, { name: 'Max D.', county: 'Santa Clara' });
  const { page } = vet;
  await page.goto('/trusted-contacts');
  const email = uniqueEmail(label.toLowerCase());
  await invite(page, label, email);
  await acceptInvite(browser, request, email, 'Max D.');
  await page.reload();
  const toggle = contactRow(page, label).getByRole('switch', { name: ALERT_SWITCH });
  await toggle.click();
  await confirmAlert(page);
  await expect(toggle).toBeChecked();
  return vet;
}

// --- Check-In ---------------------------------------------------------------------------

/** The qv-001 prompts, in the order the API serves them (SIGNAL_SCORING.md B1). */
const PROMPTS = {
  sleep: /how much has sleep made it harder/,
  connection: /How connected do you feel/,
  stress: /how much has stress made it harder/,
  basicNeeds: /How secure are your food, shelter/,
  urgency: /How soon do you need help with your most important basic need/,
  coping: /How able do you feel to get through the next 24 hours/,
  reachable: /can you reach a person or service/,
  safeNow: /Do you feel safe right now/,
  danger: /Are you in immediate danger/,
} as const;
export type PromptKey = keyof typeof PROMPTS;

/** An answer label per question, or 'skip'. Unlisted questions take the first option. */
export type Picks = Partial<Record<PromptKey, string>>;

export const DONE_HEADING = 'Thank you for checking in.';

export function questionHeading(page: Page) {
  return page.locator('form').getByRole('heading', { level: 2 });
}

/** From Home, opens the Check-In (new or resumed) on its first open question. */
export async function startCheckIn(page: Page): Promise<void> {
  await page.goto('/home');
  await page.getByRole('link', { name: /^(Start|Continue) Check-In$/ }).click();
  await expect(page).toHaveURL(/\/check-in$/);
  await expect(page.getByText(/^Question \d+ of \d+$/)).toBeVisible();
}

/**
 * Answers from the current question to the end, by prompt. Ends on the result screen, or on
 * the `stopAt` question without answering it. Returns the prompts answered or skipped.
 */
export async function answerRest(
  page: Page,
  picks: Picks = {},
  stopAt?: PromptKey,
): Promise<PromptKey[]> {
  const seen: PromptKey[] = [];
  const done = page.getByRole('heading', { level: 1, name: DONE_HEADING });
  for (;;) {
    await expect(questionHeading(page).or(done)).toBeVisible();
    if (await done.isVisible()) return seen;
    const prompt = (await questionHeading(page).textContent()) ?? '';
    const key = (Object.keys(PROMPTS) as PromptKey[]).find((k) => PROMPTS[k].test(prompt));
    expect(key, `a known qv-001 prompt: "${prompt}"`).toBeDefined();
    if (key === stopAt) return seen;
    seen.push(key!);
    const pick = picks[key!];
    if (pick === 'skip') {
      await page.getByRole('button', { name: 'Skip this question' }).click();
    } else {
      const radio =
        pick === undefined
          ? page.getByRole('radio').first()
          : page.getByRole('radio', { name: pick, exact: true });
      await radio.check();
      await page.getByRole('button', { name: 'Save answer' }).click();
    }
    await expect(questionHeading(page).filter({ hasNotText: prompt }).or(done)).toBeVisible();
  }
}
