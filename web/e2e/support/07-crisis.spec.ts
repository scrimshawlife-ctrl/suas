import type { APIRequestContext, Browser, Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { expectCrisisScreen } from '../helpers';
import { closePeople, expectCrisisChrome, serverError, veteran, visitor } from './support';

test.afterEach(closePeople);

/** SAFETY_COPY.md §2.2 minimal banner and §2.3 footer (src/ui/safety.ts), as shown. */
const STRIP_LINES = [
  'Emergency: Call 911',
  'Crisis support: Call or text 988',
  'Veterans Crisis Line: Text 838255',
  'Practical support: Continue with SUAS',
];
const FOOTER_LINES = [
  'SUAS coordinates community support. It does not provide emergency medical care or emergency dispatch.',
  'For immediate danger, call 911. For suicide or emotional crisis support, call or text 988. Veterans Crisis Line: Text 838255.',
];
/** The crisis panel's released sentences (SAFETY_COPY.md §1). */
const PANEL_LINES = [
  'If you are in immediate danger, have a medical emergency, or believe someone may be seriously harmed, call 911 or go to the nearest emergency department.',
  'SUAS coordinates practical support. It is not an emergency service and cannot replace police, fire, EMS, or emergency medical care.',
  'If you are experiencing suicidal thoughts, severe emotional distress, or a mental health crisis, call or text the 988 Suicide & Crisis Lifeline at 988.',
];

async function expectCrisisStrings(page: Page): Promise<void> {
  const strip = page.getByRole('complementary', { name: 'Crisis support' });
  for (const line of STRIP_LINES) await expect(strip).toContainText(line);
  const footer = page.getByRole('contentinfo');
  for (const line of FOOTER_LINES) await expect(footer).toContainText(line);
  await expectCrisisChrome(page);
}

/** /crisis: the released sentences, every triage answer with real targets, no "nearby" promise. */
async function expectCrisisPage(page: Page, continueTo: string): Promise<void> {
  await expectCrisisScreen(page);
  await expectCrisisStrings(page);
  const panel = page.getByRole('region', { name: 'Need help right now?' });
  for (const line of PANEL_LINES) await expect(panel).toContainText(line);
  await expect(panel.getByRole('link', { name: 'Continue with SUAS support' })).toHaveAttribute(
    'href',
    continueTo,
  );
  await expect(page.getByRole('main')).not.toContainText(/nearby/i);

  const result = page.getByRole('status').filter({ has: page.getByRole('heading', { level: 2 }) });
  const answers: [RegExp, [string, string][]][] = [
    [
      /^Yes, immediate danger/,
      [
        ['Call 911', 'tel:911'],
        ['Call or text 988', 'tel:988'],
        ['Veterans Crisis Line: Text 838255', 'sms:838255'],
      ],
    ],
    [
      /^No, urgent support needed/,
      [
        ['Call 911', 'tel:911'],
        ['Call or text 988', 'tel:988'],
        ['Continue with SUAS', continueTo],
      ],
    ],
    [
      /^Not sure/,
      [
        ['Call 911', 'tel:911'],
        ['Call or text 988', 'tel:988'],
        ['Veterans Crisis Line: Text 838255', 'sms:838255'],
        ['Continue with SUAS', continueTo],
      ],
    ],
  ];
  for (const [radio, buttons] of answers) {
    await page.getByRole('radio', { name: radio }).check();
    await expect(result.getByRole('link')).toHaveCount(buttons.length);
    for (const [name, href] of buttons) {
      await expect(result.getByRole('link', { name, exact: true })).toHaveAttribute('href', href);
    }
  }
}

test('signed out: the crisis strings are on every public screen and /crisis leads to sign in', async ({
  browser,
}) => {
  const page = await visitor(browser);
  for (const path of ['/', '/sign-in', '/no-such-page']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await expectCrisisStrings(page);
  }
  await page.goto('/crisis');
  await expectCrisisPage(page, '/sign-in');
  await page.getByRole('link', { name: 'Continue with SUAS support' }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
});

test('signed in: every support screen carries the crisis strings, and /crisis returns to Support', async ({
  browser,
  request,
}) => {
  const { page } = await veteran(browser, request, { name: 'Marcus T.', county: 'Santa Clara' });
  for (const path of [
    '/home',
    '/resources/food',
    '/check-in',
    '/trusted-contacts',
    '/consents',
    '/notifications',
    '/invitations',
  ]) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await expectCrisisStrings(page);
  }
  await page.goto('/home');
  await page.getByRole('link', { name: 'More crisis options' }).click();
  await expectCrisisPage(page, '/home');
  await expect(page.getByRole('link', { name: 'Back to Support' })).toHaveAttribute(
    'href',
    '/home',
  );
  await page.getByRole('link', { name: 'Continue with SUAS support' }).click();
  await expect(page).toHaveURL(/\/home$/);
});

/** AT07 (#285): every /api/v0 call answers 503, so nothing on screen can come from the API. */
async function failTheApi(page: Page, allow: RegExp[]): Promise<{ hits: number }> {
  // Only the routed API answers may 503; a real backend 5xx elsewhere still fails the test.
  allow.push(/\/api\/v0\/.* :: 503$/, /status of 503/);
  const seen = { hits: 0 };
  await page.route('**/api/v0/**', (route) => {
    seen.hits += 1;
    return route.fulfill(serverError(503));
  });
  return seen;
}

test('signed out with the API down: the crisis copy and destinations still show (AT07)', async ({
  browser,
  allow,
}) => {
  const page = await visitor(browser);
  await failTheApi(page, allow);
  for (const path of ['/', '/sign-in']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await expectCrisisStrings(page);
  }
  await page.goto('/crisis');
  await expectCrisisPage(page, '/sign-in');
});

test('signed in with the API down: /crisis keeps the crisis copy and destinations (AT07)', async ({
  browser,
  request,
  allow,
}) => {
  const { page } = await veteran(browser, request, { name: 'Dana R.', county: 'Santa Clara' });
  const api = await failTheApi(page, allow);
  await page.goto('/crisis');
  await expectCrisisPage(page, '/home');
  expect(api.hits).toBeGreaterThan(0);
});

/** Signed in, API down: Home cannot load the account and shows its failed screen. */
async function failedHome(browser: Browser, request: APIRequestContext, allow: RegExp[]) {
  const { page } = await veteran(browser, request, { name: 'Lee K.', county: 'Santa Clara' });
  await failTheApi(page, allow);
  await page.goto('/home');
  await expect(page.getByRole('heading', { name: 'We could not load your account.' })).toBeVisible({
    timeout: 30_000,
  });
  return page;
}

test('signed in with the API down: the failed Home screen keeps the crisis band (AT07)', async ({
  browser,
  request,
  allow,
}) => {
  const page = await failedHome(browser, request, allow);
  const strip = page.getByRole('complementary', { name: 'Crisis support' });
  for (const line of STRIP_LINES) await expect(strip).toContainText(line);
  for (const [name, href] of [
    ['Call 911', 'tel:911'],
    ['Call 988', 'tel:988'],
    ['Text 988', 'sms:988'],
    ['Veterans Crisis Line: Text 838255', 'sms:838255'],
  ] as const) {
    await expect(strip.getByRole('link', { name })).toHaveAttribute('href', href);
  }
});

test('signed in with the API down: the failed Home screen keeps the persistent footer (AT07)', async ({
  browser,
  request,
  allow,
}) => {
  const page = await failedHome(browser, request, allow);
  await expectCrisisStrings(page);
});
