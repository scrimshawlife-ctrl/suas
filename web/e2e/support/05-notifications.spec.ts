import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { ageRequest, requestHelp, runJobWorkerOnce, withDb } from '../helpers';
import {
  closePeople,
  invite,
  myUserId,
  serverError,
  uniqueSummary,
  veteran,
  type Person,
} from './support';

test.afterEach(closePeople);

const EXPIRED_NOTICE = 'Your request expired 72 hours after you sent it.';

/** A Veteran whose request ran past 72 hours, so the sweep sent them one real notice. */
async function veteranWithExpiredNotice(
  browser: Parameters<typeof veteran>[0],
  request: Parameters<typeof veteran>[1],
): Promise<Person> {
  const vet = await veteran(browser, request, { name: 'Marcus T.', county: 'Santa Clara' });
  const requestId = await requestHelp(
    vet.page,
    request,
    { category: 'FOOD', summary: uniqueSummary('Groceries') },
    'Front entrance of the library',
  );
  await ageRequest(requestId, 73 * 60);
  expect(runJobWorkerOnce()).toContain(requestId);
  return vet;
}

function items(page: Page) {
  return page.getByRole('main').getByRole('listitem');
}

test("a notice about the Veteran's request is listed with its date; Back and refresh keep it", async ({
  browser,
  request,
}) => {
  const { page } = await veteranWithExpiredNotice(browser, request);
  await page.goto('/home');
  await page
    .getByRole('navigation', { name: 'Privacy and messages' })
    .getByRole('link', { name: 'Notifications' })
    .click();
  await expect(page).toHaveURL(/\/notifications$/);
  await expect(page).toHaveTitle('Notifications · SUAS');
  const item = items(page).filter({ hasText: EXPIRED_NOTICE });
  await expect(item).toContainText(/([A-Z][a-z]{2} \d{1,2}, \d{4}|Waiting to send)/);
  // Sign-in code emails are not listed.
  await expect(items(page)).toHaveCount(1);

  await page.goBack();
  await expect(page).toHaveURL(/\/home$/);
  await page.goForward();
  await page.reload();
  await expect(items(page).filter({ hasText: EXPIRED_NOTICE })).toHaveCount(1);
});

test('an invitee who already has an account is told about the invite in Notifications', async ({
  browser,
  request,
}) => {
  // G6/G8 handoff: the invite Notification is written with no recipient_user_id
  // (deliverInvite, src/http/routes/trusted-contacts.ts), so GET /notifications never lists it,
  // and `trusted_contact_invited` has no web text (support/notification-reasons.ts).
  test.fixme(
    true,
    'trusted_contact_invited never reaches the invitee inbox (no recipient, no text)',
  );
  const contact = await veteran(browser, request, { name: 'Ann T.', county: 'Santa Clara' });
  const vet = await veteran(browser, request, { name: 'Marcus T.', county: 'Santa Clara' });
  await vet.page.goto('/trusted-contacts');
  await invite(vet.page, 'Sister', contact.email);
  await contact.page.goto('/notifications');
  await expect(items(contact.page).filter({ hasText: /trusted contact/i })).toHaveCount(1);
  await expect(contact.page.getByText('You have a new update.')).toHaveCount(0);
});

test('more notices than one page: "Show more" loads the older ones', async ({
  browser,
  request,
}) => {
  // G8 handoff: the inbox reads one page of 50 and ignores next_cursor (support/api.ts).
  test.fixme(true, 'Notifications ignore next_cursor and have no "Show more" yet (G8)');
  const vet = await veteranWithExpiredNotice(browser, request);
  // 55 older copies of the real notice: more than any page the inbox asks for.
  const userId = await myUserId(vet.page, request);
  await withDb((db) =>
    db.query(
      `INSERT INTO notifications (notification_id, tenant_id, recipient_user_id, destination,
         reason, channel, consent_basis, template_version, delivery_status, sent_at, subject_type,
         subject_id, created_at, updated_at)
       SELECT gen_random_uuid(), n.tenant_id, n.recipient_user_id, n.destination, n.reason,
         n.channel, n.consent_basis, n.template_version, 'SENT', now() - make_interval(mins => i),
         n.subject_type, n.subject_id, now() - make_interval(mins => i), now()
         FROM notifications n, generate_series(1, 55) AS i
        WHERE n.recipient_user_id = $1 AND n.reason = 'service_request_expired'`,
      [userId],
    ),
  );
  const { page } = vet;
  await page.goto('/notifications');
  await expect(items(page).first()).toBeVisible();
  expect(await items(page).count()).toBeLessThan(56);
  const more = page.getByRole('button', { name: /^Show more/ });
  await expect(more).toBeVisible();
  // Each click adds a page; wait for it before deciding whether there is another.
  while (await more.isVisible()) {
    const before = await items(page).count();
    await more.click();
    await expect.poll(() => items(page).count()).toBeGreaterThan(before);
  }
  await expect(items(page)).toHaveCount(56);
});

test('when notifications fail to load, the page says so and Try again recovers', async ({
  browser,
  request,
  allow,
}) => {
  // The 503s are the ones this test returns on purpose.
  allow.push(/:: 503$/, /status of 503/);
  const { page } = await veteran(browser, request, {
    name: 'Pat V.',
    county: 'Alameda',
    verified: false,
  });
  let fail = true;
  await page.route('**/api/v0/notifications?**', (route) =>
    fail ? route.fulfill(serverError(503)) : route.fallback(),
  );
  await page.goto('/notifications');
  await expect(page.getByRole('alert')).toContainText(
    'Something went wrong on our side. Try to load your notifications again.',
    { timeout: 30_000 },
  );
  fail = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('You have no notifications yet.')).toBeVisible();
});
