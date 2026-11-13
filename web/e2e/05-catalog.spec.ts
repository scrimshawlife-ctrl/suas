import { expect, test } from './fixtures';
import {
  newPerson,
  newVerifiedVeteran,
  scriptModel,
  shoot,
  signInWithCode,
  uniqueEmail,
} from './helpers';

test('an admin turns a pasted source into a draft, reviews and publishes it, and a Veteran sees it', async ({
  browser,
  request,
}) => {
  const veteran = await newVerifiedVeteran(browser, request, {
    name: 'Marcus T.',
    county: 'Santa Clara',
    label: 'reader',
  });
  const name = `Willow Creek Veterans Pantry ${uniqueEmail('p').slice(6, 14)}`;
  const sourceLink = 'https://pantry.example.invalid/hours';

  // Before: the Veteran's food listings do not include it.
  await veteran.page.goto('/resources/food');
  await expect(
    veteran.page.getByRole('heading', { name: 'Example Community Food Pantry (synthetic)' }),
  ).toBeVisible();
  await expect(veteran.page.getByRole('heading', { name })).toHaveCount(0);

  // The seeded admin signs in with a code, then steps up with the test second factor.
  const admin = await newPerson(browser);
  await signInWithCode(admin, request, 'admin@example.invalid');
  await expect(admin).toHaveURL(/\/home$/);
  await admin.goto('/admin/drafts');
  await expect(admin).toHaveURL(/\/admin\/mfa$/);
  await admin.getByRole('button', { name: 'Start check' }).click();
  // The dev build prints the check id and the test factor's rule ("ok-" plus the id).
  const hint = await admin.getByText(/This check id is/).textContent();
  const checkId = /This check id is ([^\s.]+)\./.exec(hint ?? '')?.[1];
  expect(checkId).toBeTruthy();
  await admin.getByLabel('Your response').fill(`ok-${checkId}`);
  await admin.getByRole('button', { name: 'Confirm' }).click();
  await expect(admin).toHaveURL(/\/admin\/drafts$/);

  // Paste a source; the scripted model reads one pantry from it.
  await scriptModel(request, [
    {
      ok: true,
      text: '',
      toolCalls: [
        {
          id: 'r1',
          name: 'record_resources',
          input: {
            resources: [
              {
                service_name: name,
                category: 'FOOD',
                counties: ['SANTA_CLARA'],
                hours: 'Weekdays 9 to 5',
                cost: 'No cost',
              },
            ],
          },
        },
      ],
    },
  ]);
  await admin
    .getByLabel('Source text')
    .fill(`${name}, Santa Clara County. Groceries, weekdays 9-5, at no cost.`);
  await admin.getByLabel('Source link').fill(sourceLink);
  await admin.getByRole('button', { name: 'Create drafts' }).click();
  await expect(admin.getByText(/Created 1 draft\./)).toBeVisible();

  // Review: the source link is kept; fix one field, save, then publish after a confirm step.
  await admin.getByRole('link', { name }).first().click();
  await expect(admin.getByRole('heading', { name })).toBeVisible();
  await expect(admin.getByRole('region', { name: 'Source' })).toContainText(sourceLink);
  await admin.getByLabel('Hours').fill('Weekdays 9 am to 5 pm');
  await admin.getByRole('button', { name: 'Add a contact method' }).click();
  await admin.getByLabel('Contact 1', { exact: true }).fill('(408) 555-0199');
  await admin.getByRole('button', { name: 'Add a contact method' }).click();
  await admin.getByLabel('Contact 2 kind').selectOption('URL');
  await admin.getByLabel('Contact 2', { exact: true }).fill('https://pantry.example.invalid');
  await admin.getByLabel('Area').fill('San José, east side');
  await admin.getByRole('button', { name: 'Save changes' }).click();
  await expect(admin.getByText('Changes saved.')).toBeVisible();
  await admin.getByRole('button', { name: 'Publish', exact: true }).click();
  await admin.getByRole('button', { name: 'Publish resource' }).click();
  await expect(admin.getByText(/Published as a verified Resource\./)).toBeVisible();
  await shoot(admin, '05-admin-draft-published');

  // After: the Veteran sees the published Resource, with the edited hours.
  await veteran.page.goto('/resources/food');
  const listing = veteran.page
    .getByRole('listitem')
    .filter({ has: veteran.page.getByRole('heading', { name }) });
  await expect(listing).toBeVisible();
  await expect(listing).toContainText('Weekdays 9 am to 5 pm');
  await expect(
    listing.getByRole('link', { name: `Call ${name} at (408) 555-0199` }),
  ).toHaveAttribute('href', 'tel:4085550199');
  await expect(listing.getByRole('link', { name: 'Visit website' })).toHaveAttribute(
    'href',
    'https://pantry.example.invalid/',
  );
  await expect(listing.getByText('San José, east side')).toBeVisible();
  await expect(listing.getByText(/^Verified [A-Z][a-z]{2} \d{1,2}$/)).toBeVisible();
  await shoot(veteran.page, '05-veteran-sees-resource');
});
