/**
 * Steps shared by the support, cross and time scenarios: people who are closed after each
 * test, the trusted-contact form, the Check-In driver, the crisis chrome, and the few database
 * steps that move time or read what the server recorded.
 */

import { randomUUID } from 'node:crypto';
import { expect, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { API_URL } from '../config';
import {
  newPerson,
  newVerifiedVeteran,
  signInWithCode,
  signUp,
  uniqueEmail,
  withDb,
  type CountyLabel,
} from '../helpers';

/** Contexts outlive their test unless closed; each spec file closes them after every test. */
const opened: Page[] = [];

export async function closePeople(): Promise<void> {
  await Promise.all(opened.splice(0).map((page) => page.context().close()));
}

function track(page: Page): Page {
  opened.push(page);
  return page;
}

/** A signed-out person with their own context. */
export async function visitor(browser: Browser): Promise<Page> {
  return track(await newPerson(browser));
}

export type Person = { page: Page; email: string };

/** A signed-up Veteran on /home: ID-checked unless `verified` is false. */
export async function veteran(
  browser: Browser,
  request: APIRequestContext,
  options: { name: string; county: CountyLabel; verified?: boolean; label?: string },
): Promise<Person> {
  if (options.verified ?? true) {
    const vet = await newVerifiedVeteran(browser, request, options);
    track(vet.page);
    return vet;
  }
  const page = track(await newPerson(browser));
  const email = uniqueEmail(options.label ?? 'support');
  await signUp(page, request, { email, name: options.name, county: options.county });
  return { page, email };
}

/** A helper (Serve) in the given county, on /serve. */
export async function helper(
  browser: Browser,
  request: APIRequestContext,
  options: { name: string; county: CountyLabel },
): Promise<Page> {
  const page = track(await newPerson(browser));
  await signUp(page, request, {
    email: uniqueEmail('helper'),
    name: options.name,
    county: options.county,
    role: 'serve',
  });
  return page;
}

/** On /admin/mfa: starts a check and answers it with the test second factor's response. */
export async function passMfa(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/admin\/mfa$/);
  await page.getByRole('button', { name: 'Start check' }).click();
  const hint = (await page.getByText(/This check id is/).textContent()) ?? '';
  const checkId = /This check id is ([^\s]+?)\.$/.exec(hint.trim())?.[1];
  expect(checkId, 'the dev hint names the check id').toBeTruthy();
  await page.getByLabel('Your response').fill(`ok-${checkId ?? ''}`);
  await page.getByRole('button', { name: 'Confirm' }).click();
}

/** The seeded admin, signed in and stepped up with the test second factor, on /admin. */
export async function elevatedAdmin(browser: Browser, request: APIRequestContext): Promise<Page> {
  // The admin may ask for three codes per 15 minutes; dropping the counters moves that window on.
  await withDb((db) => db.query(`DELETE FROM auth_rate_limits`));
  const page = track(await newPerson(browser));
  await signInWithCode(page, request, 'admin@example.invalid');
  await expect(page).toHaveURL(/\/home$/);
  await page.goto('/admin');
  await passMfa(page);
  await expect(page).toHaveURL(/\/admin$/);
  return page;
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

/** The bearer token in this tab, for the steps a person cannot do in the UI. */
export async function sessionToken(page: Page): Promise<string> {
  return page.evaluate(() => sessionStorage.getItem('suas.session') ?? '');
}

/** The signed-in person's user id, for the database steps that move time. */
export async function myUserId(page: Page, request: APIRequestContext): Promise<string> {
  const me = await request.get(`${API_URL}/api/v0/veterans/me`, {
    headers: { Authorization: `Bearer ${await sessionToken(page)}` },
  });
  expect(me.ok()).toBe(true);
  return ((await me.json()) as { user_id: string }).user_id;
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
export async function acceptInvite(
  browser: Browser,
  request: APIRequestContext,
  email: string,
  from: string,
): Promise<Page> {
  const page = track(await newPerson(browser));
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
  const vet = await veteran(browser, request, { name: 'Max D.', county: 'Santa Clara' });
  const { page } = vet;
  await page.goto('/trusted-contacts');
  const email = uniqueEmail(label.toLowerCase());
  await invite(page, label, email);
  await acceptInvite(browser, request, email, 'Max D.');
  await page.reload();
  const toggle = contactRow(page, label).getByRole('switch', { name: ALERT_SWITCH });
  await toggle.click();
  await expect(toggle).toBeChecked();
  return vet;
}

// --- Check-In ---------------------------------------------------------------------------

/** The qv-001 prompts, in the order the API serves them (SIGNAL_SCORING.md B1). */
export const PROMPTS = {
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

/** Moves every Check-In of this Veteran 25 hours back (the R8.10 resume window is 24 hours). */
export async function ageCheckIns(userId: string): Promise<void> {
  await withDb((db) =>
    db.query(
      `UPDATE check_ins SET started_at = started_at - interval '25 hours'
        WHERE veteran_user_id = $1`,
      [userId],
    ),
  );
}

/** A unique, readable summary so runs never collide on the shared boards. */
export function uniqueSummary(prefix: string): string {
  return `${prefix} ${randomUUID().slice(0, 8)}`;
}
