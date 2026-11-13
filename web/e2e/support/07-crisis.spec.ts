import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { expectCrisisScreen } from '../helpers';
import { closePeople, expectCrisisChrome, veteran, visitor } from './support';

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
