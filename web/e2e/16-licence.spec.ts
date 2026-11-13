import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { newPerson, shoot, signInWithCode, signUp, uniqueEmail, withDb } from './helpers';

/**
 * The licence fallback (suas-specs #73 R10.1, proposal) against the LOCAL fixture reader, which
 * reads SYNTHETIC / VETERAN / 1970-01-02, licence CA F0000001, for a front photo of any width but
 * 601 to 607. The VA step types the same synthetic person, so identity match is YES. The selfie
 * comes from Chrome's fake camera. No real licence or face is ever used.
 *
 * Serial: the second test relies on the first approval (one approved licence per tenant).
 */

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const PHONE = { width: 390, height: 844 };
const FIRST_ADMIN = 'admin@example.invalid';
const SECOND_ADMIN = 'accepter@example.invalid';
const THIRD_ADMIN = 'veteran2@example.invalid';

async function seriousViolations(page: Page): Promise<string[]> {
  await page.evaluate(() => document.fonts.ready);
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  return results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);
}

/** A synthetic card-shaped JPEG drawn by the browser, 856 px wide (a normal fixture read). */
async function syntheticJpeg(page: Page, label: string): Promise<Buffer> {
  const base64 = await page.evaluate((text) => {
    const canvas = document.createElement('canvas');
    canvas.width = 856;
    canvas.height = 540;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('no canvas');
    context.fillStyle = '#dfe8f0';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#123';
    context.font = '48px sans-serif';
    context.fillText(text, 40, 120);
    return canvas.toDataURL('image/jpeg', 0.9).split(',')[1] ?? '';
  }, label);
  return Buffer.from(base64, 'base64');
}

/** Grants a seeded user SUAS admin, as a second (or third) reviewer for this run. */
async function grantAdmin(email: string): Promise<void> {
  await withDb((db) =>
    db.query(
      `INSERT INTO suas_admin_grants (admin_grant_id, user_id, granted_by)
       SELECT gen_random_uuid(), u.user_id, a.user_id FROM users u, users a
        WHERE lower(u.email) = $1 AND lower(a.email) = $2
          AND NOT EXISTS (SELECT 1 FROM suas_admin_grants g
                           WHERE g.user_id = u.user_id AND g.status = 'ACTIVE')`,
      [email, FIRST_ADMIN],
    ),
  );
}

/** Signs up as the synthetic person; ZIP 00002 is the VA fixture's PERSON_NOT_FOUND vector. */
async function notConfirmedByVa(page: Page, request: APIRequestContext, label: string) {
  await signUp(page, request, {
    email: uniqueEmail(label),
    name: 'Synthetic Veteran',
    county: 'Alameda',
  });
  await page.goto('/request');
  await expect(page).toHaveURL(/\/verify$/);
  await page.getByLabel('First name').fill('Synthetic');
  await page.getByLabel('Last name').fill('Veteran');
  await page.getByLabel('Month').fill('1');
  await page.getByLabel('Day').fill('2');
  await page.getByLabel('Year').fill('1970');
  await page.getByLabel('Street address').fill('1 Example Way');
  await page.getByLabel('City').fill('Exampleton');
  await page.getByLabel('State').selectOption('CA');
  await page.getByLabel('ZIP code').fill('00002');
  await page.getByRole('button', { name: 'Send to VA' }).click();
  await expect(page.getByRole('heading', { name: "VA couldn't match your details" })).toBeFocused();
}

/** The notice, front and back from files, the selfie from the camera, then "Send for review". */
async function sendCaptures(page: Page): Promise<void> {
  await expect(
    page.getByRole('heading', { name: 'Before you send photos of your licence' }),
  ).toBeVisible();
  await page.getByLabel(/Front of your licence/).setInputFiles({
    name: 'front.jpg',
    mimeType: 'image/jpeg',
    buffer: await syntheticJpeg(page, 'SYNTHETIC FRONT'),
  });
  await page.getByLabel(/Back of your licence/).setInputFiles({
    name: 'back.jpg',
    mimeType: 'image/jpeg',
    buffer: await syntheticJpeg(page, 'SYNTHETIC BACK'),
  });
  // Camera only: two file inputs on the page, none for the selfie.
  await expect(page.locator('input[type="file"]')).toHaveCount(2);
  await page.getByRole('button', { name: 'Turn on the camera' }).click();
  await page.getByRole('button', { name: 'Take selfie' }).click();
  await expect(page.getByRole('img', { name: /as it will be sent/ })).toHaveCount(3);

  const sent = page.waitForRequest(
    (req) => req.method() === 'POST' && /\/verification\/licence/.test(req.url()),
  );
  await page.getByRole('button', { name: 'Send for review' }).click();
  const body = (await sent).postDataJSON() as Record<string, { data_base64?: string }> & {
    notice_version: string;
  };
  expect(body.notice_version).toBe('licence-notice-v1');
  for (const capture of ['front', 'back', 'selfie']) {
    // At most 1,000,000 bytes each once decoded (coordinator decision).
    expect(((body[capture]?.data_base64 ?? '').length * 3) / 4).toBeLessThanOrEqual(1_000_000);
  }
  // LOCAL reads inline after the submit, so "reading" may pass before the page shows it.
  await expect(
    page.getByRole('heading', { name: 'A SUAS admin will check your licence' }),
  ).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Crisis support' })).toBeVisible();
}

async function veteranSendsLicence(
  browser: Browser,
  request: APIRequestContext,
  label: string,
): Promise<Page> {
  const page = await newPerson(browser);
  await notConfirmedByVa(page, request, label);
  await page.getByRole('link', { name: 'Confirm with your Veteran licence' }).click();
  await expect(page).toHaveURL(/\/verify\/licence$/);
  expect(await seriousViolations(page)).toEqual([]);
  await sendCaptures(page);
  return page;
}

/** Signs an admin in, steps up with the test second factor and lands on the licence queue. */
async function adminOnQueue(
  browser: Browser,
  request: APIRequestContext,
  email: string,
): Promise<Page> {
  const admin = await newPerson(browser);
  // The shared seeded admins also sign in for other specs; clear their sign-in issue count
  // (AUTH.md §3, three per 15 minutes) so the full suite does not lock them out here.
  await withDb((db) => db.query('DELETE FROM auth_rate_limits WHERE subject = $1', [email]));
  await signInWithCode(admin, request, email);
  await expect(admin).not.toHaveURL(/\/sign-in/);
  await admin.goto('/admin/licence-reviews');
  await expect(admin).toHaveURL(/\/admin\/mfa$/);
  await admin.getByRole('button', { name: 'Start check' }).click();
  const hint = await admin.getByText(/This check id is/).textContent();
  const checkId = /This check id is ([^\s.]+)\./.exec(hint ?? '')?.[1];
  expect(checkId).toBeTruthy();
  await admin.getByLabel('Your response').fill(`ok-${checkId}`);
  await admin.getByRole('button', { name: 'Confirm' }).click();
  await expect(admin).toHaveURL(/\/admin\/licence-reviews$/);
  await expect(admin.getByRole('heading', { level: 1, name: 'Licence reviews' })).toBeVisible();
  return admin;
}

/** Opens the newest review in the queue (oldest first), with only the images showing. */
async function openNewest(admin: Page): Promise<void> {
  await admin
    .getByRole('link', { name: /^Licence review, sent / })
    .last()
    .click();
  await expect(admin.getByRole('heading', { level: 1, name: 'Licence review' })).toBeVisible();
  for (const name of ['Front of the licence', 'Back of the licence', 'Selfie']) {
    await expect(admin.getByRole('img', { name })).toBeVisible();
  }
  await expect(admin.getByText('SYNTHETIC', { exact: true })).toHaveCount(0);
  await admin.getByRole('radio', { name: /Yes, I can see it/ }).check();
  await expect(admin.getByText('SYNTHETIC', { exact: true })).toBeVisible();
}

async function tickChecklist(admin: Page): Promise<void> {
  for (const box of await admin.getByRole('checkbox').all()) await box.check();
}

test.describe.serial('licence fallback', () => {
  test('submit, read, first approval, second-admin confirmation, then Request help opens', async ({
    browser,
    request,
  }) => {
    const veteran = await veteranSendsLicence(browser, request, 'licence-approve');
    await shoot(veteran, 'licence-awaiting');

    const first = await adminOnQueue(browser, request, FIRST_ADMIN);
    await openNewest(first);
    await expect(first.getByText('Matches the details given to VA: yes.')).toBeVisible();
    await expect(
      first.getByRole('heading', {
        name: 'Consistency checks: these do not show the card is genuine',
      }),
    ).toBeVisible();
    expect(await seriousViolations(first)).toEqual([]);
    await shoot(first, 'licence-admin-review');
    await tickChecklist(first);
    await first.getByRole('button', { name: 'Approve (first review)' }).click();
    await first.getByRole('button', { name: 'Approve licence' }).click();
    await expect(
      first.getByText('You approved this review, so a different admin must confirm it.'),
    ).toBeVisible();
    await expect(first.getByRole('button', { name: 'Confirm approval' })).toHaveCount(0);

    // Not yet confirmed: the Veteran still waits.
    await veteran.reload();
    await expect(
      veteran.getByRole('heading', { name: 'A SUAS admin will check your licence' }),
    ).toBeVisible();

    await grantAdmin(SECOND_ADMIN);
    const second = await adminOnQueue(browser, request, SECOND_ADMIN);
    await expect(second.getByText('To confirm')).toBeVisible();
    await openNewest(second);
    await tickChecklist(second);
    await second.getByRole('button', { name: 'Confirm approval' }).click();
    await second.getByRole('dialog').getByRole('button', { name: 'Confirm approval' }).click();
    await expect(second.getByText(/^Approved and confirmed\./)).toBeVisible();
    await expect(second.getByRole('img')).toHaveCount(0);

    // No notification in v1: the Veteran sees the result on their next visit (L6.4).
    await veteran.reload();
    await expect(veteran.getByRole('heading', { name: /You're confirmed/ })).toBeVisible();
    await veteran.getByRole('link', { name: 'Continue' }).click();
    await expect(veteran).toHaveURL(/\/request$/);
    await expect(veteran.getByRole('heading', { level: 1, name: 'Request help' })).toBeVisible();
  });

  test('the same licence is declined as already used, and the Veteran disputes it', async ({
    browser,
    request,
  }) => {
    const veteran = await veteranSendsLicence(browser, request, 'licence-dispute');

    const first = await adminOnQueue(browser, request, FIRST_ADMIN);
    await openNewest(first);
    await expect(
      first.getByText('This licence is already on an approved review in this tenant.'),
    ).toBeVisible();
    await tickChecklist(first);
    await expect(first.getByRole('button', { name: 'Approve (first review)' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await first.getByRole('button', { name: 'Decline', exact: true }).click();
    await first.getByLabel('Reason').selectOption('ALREADY_USED');
    await first.getByRole('button', { name: 'Decline licence' }).click();
    await expect(
      first.getByText(/^Declined: Licence already used for another account\./),
    ).toBeVisible();

    await veteran.reload();
    await expect(
      veteran.getByRole('heading', {
        name: "We couldn't confirm your Veteran status from your licence",
      }),
    ).toBeVisible();
    await expect(
      veteran.getByText('This licence has already been used to confirm Veteran status on SUAS.'),
    ).toBeVisible();
    await expect(veteran.getByText('This is not a finding that you did not serve.')).toBeVisible();
    await expect(veteran.getByText('ALREADY_USED')).toHaveCount(0);
    await expect(veteran.getByRole('link', { name: 'Go to Serve' })).toHaveAttribute(
      'href',
      '/serve',
    );
    await expect(veteran.getByRole('complementary', { name: 'Crisis support' })).toBeVisible();
    await shoot(veteran, 'licence-declined');
    await veteran.setViewportSize(PHONE);
    expect(await veteran.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      PHONE.width,
    );
    expect(await seriousViolations(veteran)).toEqual([]);
    await veteran.setViewportSize({ width: 1280, height: 900 });

    // L7.3: a new review marked as a dispute, with new captures.
    await veteran
      .getByRole('button', { name: 'If this is your licence, ask us to look again' })
      .click();
    await expect(veteran.getByRole('heading', { name: 'Ask us to look again' })).toBeVisible();
    await sendCaptures(veteran);

    // The admins who approved and confirmed the conflicting review never see the dispute.
    await first.goto('/admin/licence-reviews');
    await expect(first.getByRole('heading', { level: 1, name: 'Licence reviews' })).toBeVisible();
    await expect(first.getByText('Dispute', { exact: true })).toHaveCount(0);

    await grantAdmin(THIRD_ADMIN);
    const third = await adminOnQueue(browser, request, THIRD_ADMIN);
    await expect(third.getByText('Dispute', { exact: true })).toBeVisible();
    await openNewest(third);
    const record = third.getByRole('region', { name: 'Dispute' });
    await expect(record).toContainText('Its images were deleted');
    await expect(record).toContainText('licence-notice-v1');
    await expect(record.getByRole('button', { name: 'Revoke that approval' })).toBeVisible();
    await shoot(third, 'licence-admin-dispute');
  });

  test('licence path is never offered after a VA 400', async ({ page, request }) => {
    await signUp(page, request, {
      email: uniqueEmail('licence-va400'),
      name: 'Synthetic Veteran',
      county: 'Alameda',
    });
    await page.goto('/request');
    await expect(page).toHaveURL(/\/verify$/);
    await page.getByLabel('First name').fill('Synthetic');
    await page.getByLabel('Last name').fill('Veteran');
    await page.getByLabel('Month').fill('1');
    await page.getByLabel('Day').fill('2');
    await page.getByLabel('Year').fill('1970');
    await page.getByLabel('Street address').fill('1 Example Way');
    await page.getByLabel('City').fill('Exampleton');
    await page.getByLabel('State').selectOption('CA');
    // 00006: the fixture's simulated VA 400, UNAVAILABLE / REQUEST_INVALID.
    await page.getByLabel('ZIP code').fill('00006');
    const offer = page.waitForResponse(
      (res) => res.request().method() === 'GET' && /\/verification\/licence$/.test(res.url()),
    );
    await page.getByRole('button', { name: 'Send to VA' }).click();
    await expect(
      page.getByRole('heading', { name: "We couldn't send your details to VA" }),
    ).toBeFocused();
    expect(((await (await offer).json()) as { offered: boolean }).offered).toBe(false);
    await expect(page.getByRole('link', { name: 'Confirm with your Veteran licence' })).toHaveCount(
      0,
    );
    // Opening the licence page directly leads back to Verify.
    await page.goto('/verify/licence');
    await expect(page).toHaveURL(/\/verify$/);
  });
});
