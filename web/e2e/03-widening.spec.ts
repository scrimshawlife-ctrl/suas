import { expect, test } from '@playwright/test';
import {
  ageRequest,
  newPerson,
  newVerifiedVeteran,
  requestHelp,
  runJobWorkerOnce,
  shoot,
  signUp,
  uniqueEmail,
} from './helpers';

test('an unaccepted request widens to a bordering county after the delay', async ({
  browser,
  request,
}) => {
  // Santa Cruz borders Santa Clara, San Mateo and San Benito, and not Alameda
  // (migrations/0013_peer_matching.sql, county_adjacency).
  const requester = await newVerifiedVeteran(browser, request, {
    name: 'Marcus T.',
    county: 'Santa Cruz',
    label: 'requester',
  });
  const summary = `Groceries for the week ${uniqueEmail('w').slice(6, 14)}`;
  const requestId = await requestHelp(
    requester.page,
    request,
    { category: 'FOOD', summary },
    'Corner of Pacific Ave and Soquel Ave',
  );

  const sameCounty = await newPerson(browser);
  const bordering = await newPerson(browser);
  const distant = await newPerson(browser);
  await signUp(sameCounty, request, {
    email: uniqueEmail('same'),
    name: 'Sam P.',
    county: 'Santa Cruz',
    role: 'serve',
  });
  await signUp(bordering, request, {
    email: uniqueEmail('near'),
    name: 'Dee R.',
    county: 'San Mateo',
    role: 'serve',
  });
  await signUp(distant, request, {
    email: uniqueEmail('far'),
    name: 'Lee K.',
    county: 'Alameda',
    role: 'serve',
  });

  const list = (page: typeof bordering) => page.getByRole('region', { name: 'Open requests' });

  // Before the delay: only the requester's own county sees it.
  await expect(list(sameCounty)).toContainText(summary);
  await expect(list(bordering)).toContainText('No open requests right now.');
  await expect(list(distant)).toContainText('No open requests right now.');

  // Time skip: the request was sent 31 minutes ago (the delay is the stored 30), then the
  // scheduled sweep runs once.
  await ageRequest(requestId, 31);
  const output = runJobWorkerOnce();
  expect(output).toContain('"msg":"request_widened"');
  expect(output).toContain(requestId);

  // After: the bordering county sees it, marked as a nearby county; the distant one does not.
  await bordering.reload();
  await expect(list(bordering)).toContainText(summary);
  await expect(list(bordering).getByText('Nearby county')).toBeVisible();
  await expect(bordering.getByText(/San Mateo County and bordering counties/)).toBeVisible();
  await distant.reload();
  await expect(list(distant)).toContainText('No open requests right now.');
  await sameCounty.reload();
  await expect(list(sameCounty)).toContainText(summary);
  await shoot(bordering, '03-widened-serve-list');
});
