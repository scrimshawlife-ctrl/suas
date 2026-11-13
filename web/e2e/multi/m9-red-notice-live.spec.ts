/**
 * M9: the RED notice arrives while the trusted contact already has /notifications open. The
 * page should show it without a reload; `page.clock` stands in for the wait.
 */

import { expect, test } from '../fixtures';
import { pauseAfterPoll, runClock } from '../helpers';
import { veteranWithRedContact, redCheckIn } from './multi';

test.describe.configure({ timeout: 180_000 });

/** The Notifications page poll (NOTIFICATION_REFRESH_MS in src/features/support/api.ts). */
const NOTICES_POLL_MS = 30_000;
const isNoticesRead = (url: string) => url.includes('/api/v0/notifications');
const NOTICE = /Someone who named you as a trusted contact asked SUAS to send you this notice/;

// The Notifications page polls every 30 s (#290), so the notice shows without a reload.
test('a RED notice shows on the open Notifications page without a reload', async ({
  browser,
  request,
}) => {
  const { veteran, contact } = await veteranWithRedContact(browser, request);
  await contact.clock.install();
  await contact.goto('/notifications');
  await expect(contact.getByRole('heading', { name: 'Notifications' })).toBeVisible();
  await expect(contact.getByText(NOTICE)).toHaveCount(0);
  await pauseAfterPoll(contact, isNoticesRead, NOTICES_POLL_MS);

  await redCheckIn(veteran);

  // Not before the next poll; shown once it lands.
  await runClock(contact, NOTICES_POLL_MS - 2_000);
  await expect(contact.getByText(NOTICE)).toHaveCount(0);
  await runClock(contact, 2_000);
  await contact.clock.resume();
  await expect(contact.getByText(NOTICE)).toBeVisible();
});
