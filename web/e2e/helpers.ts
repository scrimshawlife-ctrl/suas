/**
 * Small helpers shared by the scenarios. The browser does everything a person can do.
 * API calls are limited to what a person cannot: reading the fake sign-in code, scripting
 * the fake model's replies, and moving time (a direct database write and the job worker).
 */

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import pg from 'pg';
import { API_URL, DATABASE_URL, stackEnv } from './config';

export type CountyLabel =
  'Santa Clara' | 'San Mateo' | 'Alameda' | 'Santa Cruz' | 'San Benito' | 'Merced' | 'Stanislaus';

/** A synthetic address no one can receive mail at. Unique per call so runs never collide. */
export function uniqueEmail(role: string): string {
  return `e2e-${role}-${randomUUID().slice(0, 8)}@example.invalid`;
}

/** A person with their own browser context, so two people can be signed in at once. */
export async function newPerson(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  return context.newPage();
}

/** Reads the fake sign-in code (LOCAL only). A person would read it from their email. */
export async function readSignInCode(request: APIRequestContext, email: string): Promise<string> {
  const response = await request.get(`${API_URL}/api/v0/dev/last-challenge`, {
    params: { destination: email },
  });
  expect(response.ok(), 'the fake email store holds a code').toBe(true);
  return ((await response.json()) as { code: string }).code;
}

/** Queues replies for the fake model (the Intake Assistant and the catalog builder). */
export async function scriptModel(request: APIRequestContext, turns: unknown[]): Promise<void> {
  const response = await request.post(`${API_URL}/api/v0/dev/model-inference/turns`, {
    data: { turns },
  });
  expect(response.status()).toBe(202);
}

/** Types an address on /sign-in, asks for a code and enters it. */
export async function signInWithCode(
  page: Page,
  request: APIRequestContext,
  email: string,
  role: 'need' | 'serve' = 'need',
): Promise<void> {
  await page.goto('/sign-in');
  const roleName = role === 'need' ? /I need support/ : /I want to serve/;
  await page.getByRole('radio', { name: roleName }).check();
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Send sign-in code' }).click();
  await expect(page).toHaveURL(/\/sign-in\/code$/);
  await page.getByLabel('6-digit code').fill(await readSignInCode(request, email));
  await page.getByRole('button', { name: 'Verify and continue' }).click();
}

/** New email → code → profile (display name and county). Ends on the role's home page. */
export async function signUp(
  page: Page,
  request: APIRequestContext,
  options: { email: string; name: string; county: CountyLabel; role?: 'need' | 'serve' },
): Promise<void> {
  const role = options.role ?? 'need';
  await signInWithCode(page, request, options.email, role);
  await expect(page).toHaveURL(/\/welcome$/);
  await page.getByLabel('Name other veterans will see').fill(options.name);
  await page.getByLabel('County').selectOption({ label: options.county });
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await expect(page).toHaveURL(role === 'need' ? /\/home$/ : /\/serve$/);
}

/**
 * Opens the request gate through the API with D-016 self-attestation (suas-specs #72
 * R9.1 D1), for scenarios about something else; the Verify form itself is driven in
 * 15-verify. VA confirmation binds one identity per account and needs a matching name, so a
 * shared synthetic person cannot confirm every e2e user. Then the page shows the
 * confirmed state.
 */
export async function passIdCheck(page: Page): Promise<void> {
  const token = await page.evaluate(() => window.sessionStorage.getItem('suas.session'));
  expect(token, 'a signed-in session').not.toBeNull();
  const response = await page.request.post(
    `${API_URL}/api/v0/veterans/me/verification/commands/self-attest`,
    {
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() },
      data: {},
    },
  );
  expect(response.status()).toBe(200);
  await page.goto('/verify');
  // A self-attested standing reads "Thanks. You can ask for help now." once the page names
  // how the person was confirmed; "You're confirmed" is kept for a VA answer.
  await expect(
    page.getByRole('heading', { name: /You're confirmed|Thanks\. You can ask for help now\./ }),
  ).toBeVisible();
}

/** A new, signed-in, ID-checked Veteran in the given county, on /home. */
export async function newVerifiedVeteran(
  browser: Browser,
  request: APIRequestContext,
  options: { name: string; county: CountyLabel; label?: string },
): Promise<{ page: Page; email: string }> {
  const page = await newPerson(browser);
  const email = uniqueEmail(options.label ?? 'vet');
  await signUp(page, request, { email, name: options.name, county: options.county });
  await passIdCheck(page);
  // Continue with no return path goes to /request; Home is one link back from there.
  await page.getByRole('link', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/request$/);
  await page.getByRole('link', { name: /back to home/i }).click();
  await expect(page).toHaveURL(/\/home$/);
  return { page, email };
}

/** The crisis screen: its heading, and 911 and 988 as red-flagged call buttons. */
export async function expectCrisisScreen(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/crisis$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Immediate resources' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Call 911' }).first()).toHaveAttribute(
    'href',
    'tel:911',
  );
  await expect(page.getByRole('link', { name: 'Call or text 988' }).first()).toHaveAttribute(
    'href',
    'tel:988',
  );
}

/** A scripted Intake Assistant turn pair: the draft tool call, then a closing line. */
export function draftTurns(draft: {
  category: 'FOOD' | 'TRANSPORTATION' | 'SHELTER' | 'PEER_SUPPORT';
  summary: string;
  timing?: string;
  meeting_place?: string;
}): unknown[] {
  return [
    {
      ok: true,
      text: '',
      toolCalls: [
        { id: `draft-${randomUUID().slice(0, 6)}`, name: 'draft_service_request', input: draft },
      ],
    },
    { ok: true, text: 'I drafted a request from what you wrote. Please check it.', toolCalls: [] },
  ];
}

/**
 * Asks for help through the Intake Assistant and the draft card, ending on /requests/:id.
 * Returns the request id from the address.
 */
export async function requestHelp(
  page: Page,
  request: APIRequestContext,
  draft: Parameters<typeof draftTurns>[0],
  meetingPlace: string,
): Promise<string> {
  await scriptModel(request, draftTurns(draft));
  await page.goto('/request');
  await page
    .getByLabel('Tell us what you need')
    .fill(`I need ${draft.category.toLowerCase()} help. ${draft.summary}`);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const card = page.getByRole('region', { name: 'Check your request' });
  await expect(card).toBeVisible();
  await card.getByLabel('Where should the helper meet you?').fill(meetingPlace);
  await card.getByRole('button', { name: 'Send request' }).click();
  await expect(page).toHaveURL(/\/requests\/[0-9a-f-]{36}$/);
  return page.url().split('/').pop() ?? '';
}

/** Runs a query on the e2e database. Used only to move time and to read recorded rows. */
export async function withDb<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/** Pretends a request was sent `minutes` ago, so the widening delay has passed. */
export async function ageRequest(serviceRequestId: string, minutes: number): Promise<void> {
  await withDb((db) =>
    db.query(
      `UPDATE service_requests SET submitted_at = submitted_at - make_interval(mins => $2)
        WHERE service_request_id = $1`,
      [serviceRequestId, minutes],
    ),
  );
}

/**
 * One pass of the job worker (`src/cli/job-worker.ts --once`), which runs the widening
 * sweep. The sweep is the scheduled job; the suite runs it on demand.
 */
export function runJobWorkerOnce(): string {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx/esm', 'src/cli/job-worker.ts', '--once'],
    {
      cwd: resolve(import.meta.dirname, '..', '..'),
      // The worker never touches the API, so a throwaway secret is enough for config.
      env: stackEnv(randomUUID() + randomUUID()),
      encoding: 'utf8',
    },
  );
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

/** A 1280 px and a 390 px screenshot of the current page, for review (never committed). */
export async function shoot(page: Page, name: string): Promise<void> {
  const dir =
    process.env['SUAS_E2E_SHOTS_DIR'] ?? resolve(import.meta.dirname, '..', 'e2e-results', 'shots');
  mkdirSync(dir, { recursive: true });
  const original = page.viewportSize() ?? { width: 1280, height: 900 };
  for (const [label, width, height] of [
    ['1280', 1280, 900],
    ['390', 390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: resolve(dir, `${name}-${label}.png`), fullPage: true });
  }
  await page.setViewportSize(original);
}

/**
 * Runs this page's paused clock forward a second at a time, letting real network answers land
 * between steps; one big jump would also fire the API client's 30 s timeout on reads in flight.
 */
export async function runClock(page: Page, ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 1000) {
    await page.clock.runFor(Math.min(1000, left));
    await new Promise((settle) => setTimeout(settle, 50));
  }
}

/**
 * Pauses this page's installed clock within a second after its next poll matching `isPoll`, so
 * the test knows the poll phase: the following poll is `intervalMs` later, not sooner.
 */
export async function pauseAfterPoll(
  page: Page,
  isPoll: (url: string) => boolean,
  intervalMs: number,
): Promise<void> {
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 100);
  for (let ran = 0; ran <= intervalMs; ran += 1000) {
    const polled = page
      .waitForRequest((r) => r.method() === 'GET' && isPoll(r.url()), { timeout: 300 })
      .then(() => true)
      .catch(() => false);
    await page.clock.runFor(1000);
    if (await polled) return;
  }
  throw new Error(`no poll within ${String(intervalMs)} ms`);
}
