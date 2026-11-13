import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { newPerson, newVerifiedVeteran, requestHelp, signUp, uniqueEmail } from './helpers';

/** WCAG 2.0, 2.1 and 2.2 at levels A and AA. */
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/** Waits for the page's own content, then returns its serious and critical axe violations. */
async function seriousViolations(page: Page, ready: Locator): Promise<string[]> {
  await expect(ready).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  return results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);
}

test('the main screens have no serious or critical WCAG A/AA violations', async ({
  browser,
  request,
}) => {
  const found: Record<string, string[]> = {};
  const check = async (page: Page, name: string, ready: Locator) => {
    found[name] = await seriousViolations(page, ready);
  };

  // Signed out: Landing, Sign in, Crisis.
  const visitor = await newPerson(browser);
  await visitor.goto('/');
  await check(visitor, 'landing', visitor.getByRole('heading', { level: 1 }));
  await visitor.goto('/sign-in');
  await check(visitor, 'sign-in', visitor.getByRole('heading', { name: 'Join the mission' }));
  await visitor.goto('/crisis');
  await check(
    visitor,
    'crisis',
    visitor.getByRole('heading', { level: 1, name: 'Immediate resources' }),
  );

  // A verified Veteran: Home, Request help, Resources; then a request for the helper.
  const veteran = await newVerifiedVeteran(browser, request, {
    name: 'Marcus T.',
    county: 'Santa Clara',
    label: 'a11y-vet',
  });
  await check(veteran.page, 'home', veteran.page.getByRole('heading', { name: /Marcus/ }));
  await veteran.page.goto('/request');
  await check(
    veteran.page,
    'request',
    veteran.page.getByRole('heading', { level: 1, name: 'Request help' }),
  );
  await veteran.page.goto('/resources/food');
  await check(veteran.page, 'resources', veteran.page.getByRole('heading', { level: 1 }));
  const summary = `Ride to the clinic ${uniqueEmail('a').slice(6, 14)}`;
  const requestId = await requestHelp(
    veteran.page,
    request,
    { category: 'TRANSPORTATION', summary, timing: 'Tomorrow at 9 am' },
    'Front entrance of the library',
  );

  // A helper: Serve, then the Case and Chat after accepting.
  const helper = await newPerson(browser);
  await signUp(helper, request, {
    email: uniqueEmail('a11y-helper'),
    name: 'Dee R.',
    county: 'Santa Clara',
    role: 'serve',
  });
  const open = helper.getByRole('region', { name: 'Open requests' });
  await expect(open).toContainText(summary);
  await check(helper, 'serve', open);
  await helper.getByRole('button', { name: new RegExp(`Take this request: .*${summary}`) }).click();
  await expect(helper).toHaveURL(new RegExp(`/serve/requests/${requestId}$`));
  await check(helper, 'case', helper.getByRole('region', { name: "What's needed" }));
  await helper.goto(`/chat/${requestId}`);
  await check(helper, 'chat', helper.getByRole('heading', { name: 'Marcus T.' }));

  for (const [name, violations] of Object.entries(found)) {
    expect.soft(violations, `axe violations on ${name}`).toEqual([]);
  }
});
