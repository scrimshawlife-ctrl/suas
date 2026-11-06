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

/** The fake ID check: Start verification, then wait for the confirmed state. */
export async function passIdCheck(page: Page): Promise<void> {
  await page.goto('/verify');
  await page.getByRole('button', { name: 'Start verification' }).click();
  await expect(page.getByRole('heading', { name: /You're confirmed/ })).toBeVisible();
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
  await page
    .getByRole('link', { name: 'Continue' })
    .or(page.getByRole('button', { name: 'Continue' }))
    .click();
  await expect(page).toHaveURL(/\/home$/);
  return { page, email };
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
