import AxeBuilder from '@axe-core/playwright';
import { randomUUID } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { passIdCheck, readSignInCode, requestHelp, scriptModel, uniqueEmail } from '../helpers';
import { closePeople, elevatedAdmin, helper, uniqueSummary, visitor } from '../support/support';

test.afterEach(closePeople);

/** WCAG 2.0, 2.1 and 2.2 at levels A and AA, as in 11-a11y. */
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
/** Phone (WCAG 1.4.10 reflow), common phone, desktop. */
const WIDTHS = [320, 390, 1280] as const;

/**
 * Every route in web/src/app/router.tsx except /dev/components, opened by the person who can
 * see it. Each is checked at every width: serious and critical axe findings, and sideways scroll.
 */
test('every routed page: no serious or critical axe violation and no sideways scroll at 320, 390 and 1280 px', async ({
  browser,
  request,
}) => {
  test.setTimeout(420_000);
  const found: Record<string, string[]> = {};
  const checked: string[] = [];

  async function check(page: Page, route: string, ready?: Locator): Promise<void> {
    await expect(ready ?? page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: width === 1280 ? 900 : 760 });
      await page.evaluate(() => document.fonts.ready);
      const problems: string[] = [];
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      if (scrollWidth > width) problems.push(`scrolls sideways: ${String(scrollWidth)} px`);
      const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
      for (const v of results.violations) {
        if (v.impact === 'serious' || v.impact === 'critical') {
          problems.push(
            `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
          );
        }
      }
      found[`${route} @${String(width)}`] = problems;
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    checked.push(route);
  }

  // Signed out.
  const vet = await visitor(browser);
  for (const path of ['/', '/crisis', '/no-such-page', '/sign-in']) {
    await vet.goto(path);
    await check(vet, path);
  }

  // One Veteran through onboarding, then every support and request screen.
  const email = uniqueEmail('a11y');
  await vet.getByRole('radio', { name: /I need support/ }).check();
  await vet.getByLabel('Email address').fill(email);
  await vet.getByRole('button', { name: 'Send sign-in code' }).click();
  await expect(vet).toHaveURL(/\/sign-in\/code$/);
  await check(vet, '/sign-in/code');
  await vet.getByLabel('6-digit code').fill(await readSignInCode(request, email));
  await vet.getByRole('button', { name: 'Verify and continue' }).click();
  await expect(vet).toHaveURL(/\/welcome$/);
  await check(vet, '/welcome');
  await vet.getByLabel('Name other veterans will see').fill('Marcus T.');
  await vet.getByLabel('County').selectOption({ label: 'Santa Clara' });
  await vet.getByRole('button', { name: 'Save and continue' }).click();
  await expect(vet).toHaveURL(/\/home$/);
  await vet.goto('/verify');
  await check(vet, '/verify');
  await passIdCheck(vet);
  for (const path of [
    '/home',
    '/request',
    '/resources/food',
    '/check-in',
    '/consents',
    '/trusted-contacts',
    '/notifications',
    '/invitations',
    '/chat',
  ]) {
    await vet.goto(path);
    await check(vet, path, path === '/chat' ? vet.getByRole('main') : undefined);
  }
  const summary = uniqueSummary('Ride to the clinic');
  const requestId = await requestHelp(
    vet,
    request,
    { category: 'TRANSPORTATION', summary, timing: 'Tomorrow at 9 am' },
    'Front entrance of the library',
  );
  await check(vet, '/requests/:id');
  await vet.goto('/requests');
  await check(vet, '/requests');

  // A helper: the board, the case, and the chat on both sides.
  const serve = await helper(browser, request, { name: 'Dee R.', county: 'Santa Clara' });
  await check(serve, '/serve');
  await serve.getByRole('button', { name: new RegExp(`Take this request: .*${summary}`) }).click();
  await expect(serve).toHaveURL(new RegExp(`/serve/requests/${requestId}$`));
  await check(serve, '/serve/requests/:id', serve.getByRole('region', { name: "What's needed" }));
  await vet.goto(`/chat/${requestId}`);
  await check(vet, '/chat/:serviceRequestId', vet.getByRole('heading', { name: 'Dee R.' }));

  // The admin: step-up, overview, drafts, one draft, consent templates.
  const admin = await elevatedAdmin(browser, request);
  await check(admin, '/admin');
  await admin.goto('/admin/consent-templates');
  await check(admin, '/admin/consent-templates');
  await admin.goto('/admin/drafts');
  await check(admin, '/admin/drafts');
  const name = `A11y Pantry ${randomUUID().slice(0, 6)}`;
  await scriptModel(request, [
    {
      ok: true,
      text: '',
      toolCalls: [
        {
          id: `r-${randomUUID().slice(0, 6)}`,
          name: 'record_resources',
          input: { resources: [{ service_name: name, category: 'FOOD', counties: [] }] },
        },
      ],
    },
  ]);
  await admin.getByLabel('Source text').fill(`${name}. Weekdays.`);
  await admin.getByLabel('Source link').fill('https://source.example.invalid/listing');
  await admin.getByRole('button', { name: 'Create drafts' }).click();
  await admin.getByRole('status').getByRole('link', { name }).click();
  await expect(admin).toHaveURL(/\/admin\/drafts\/[0-9a-f-]{36}$/);
  await check(admin, '/admin/drafts/:id');
  // A fresh tab has no MFA flag, so the step-up screen shows.
  const stepUp = await admin.context().newPage();
  await stepUp.goto('/');
  await stepUp.evaluate(
    ([token]) => sessionStorage.setItem('suas.session', token ?? ''),
    [await admin.evaluate(() => sessionStorage.getItem('suas.session'))],
  );
  await stepUp.goto('/admin/mfa');
  await check(stepUp, '/admin/mfa');

  expect(checked).toHaveLength(26);
  for (const [where, problems] of Object.entries(found)) {
    expect.soft(problems, where).toEqual([]);
  }
});
