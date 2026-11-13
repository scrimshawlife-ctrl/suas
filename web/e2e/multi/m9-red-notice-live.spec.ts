/**
 * M9: the RED notice arrives while the trusted contact already has /notifications open. The
 * page should show it without a reload; `page.clock` stands in for the wait.
 */

import { expect, test } from '../fixtures';
import { veteranWithRedContact, redCheckIn } from './multi';

test.describe.configure({ timeout: 180_000 });

const NOTICE = /Someone who named you as a trusted contact asked SUAS to send you this notice/;

// Bug (handoff to C, owner of support/api.ts paging): useNotifications has no refetchInterval
// and refetchOnWindowFocus is off, so a notice that arrives while the page is open never shows.
test.fixme('a RED notice shows on the open Notifications page without a reload', async ({
  browser,
  request,
}) => {
  const { veteran, contact } = await veteranWithRedContact(browser, request);
  await contact.clock.install();
  await contact.goto('/notifications');
  await expect(contact.getByRole('heading', { name: 'Notifications' })).toBeVisible();
  await expect(contact.getByText(NOTICE)).toHaveCount(0);

  await redCheckIn(veteran);

  await contact.clock.fastForward('01:05');
  await expect(contact.getByText(NOTICE)).toBeVisible();
});
