import { expect, test, type Page } from '@playwright/test';
import { newPerson, newVerifiedVeteran, requestHelp, shoot, signUp, uniqueEmail } from './helpers';

/** Records the WebSockets a page opens and the text of every frame it receives. */
function recordSocket(page: Page): { opened: () => number; frames: string[] } {
  const frames: string[] = [];
  let opened = 0;
  page.on('websocket', (socket) => {
    opened += 1;
    socket.on('framereceived', (frame) => frames.push(String(frame.payload)));
  });
  return { opened: () => opened, frames };
}

test('a second account accepts the request, sees the meeting place and chats live both ways', async ({
  browser,
  request,
}) => {
  const requester = await newVerifiedVeteran(browser, request, {
    name: 'Marcus T.',
    county: 'Santa Clara',
    label: 'requester',
  });
  const summary = `Ride to the clinic ${uniqueEmail('r').slice(6, 14)}`;
  const meetingPlace = 'Front entrance of the library';
  const requestId = await requestHelp(
    requester.page,
    request,
    { category: 'TRANSPORTATION', summary, timing: 'Tomorrow at 9 am' },
    meetingPlace,
  );

  // The second account needs no ID check: any signed-in person with a profile can help.
  const helper = await newPerson(browser);
  await signUp(helper, request, {
    email: uniqueEmail('helper'),
    name: 'Dee R.',
    county: 'Santa Clara',
    role: 'serve',
  });
  await expect(helper.getByRole('heading', { name: /Ready to serve, Dee/ })).toBeVisible();
  const open = helper.getByRole('region', { name: 'Open requests' });
  await expect(open).toContainText(summary);
  // The meeting place stays private until the request is taken.
  await expect(open).not.toContainText(meetingPlace);

  await helper.getByRole('button', { name: new RegExp(`Take this request: .*${summary}`) }).click();
  await expect(helper).toHaveURL(new RegExp(`/serve/requests/${requestId}$`));
  await expect(helper.getByRole('region', { name: "What's needed" })).toContainText(meetingPlace);
  await expect(helper.getByRole('region', { name: "What's needed" })).toContainText('Marcus T.');
  // The status chip and the History row both read "You accepted" (Case board).
  await expect(helper.getByText('You accepted').first()).toBeVisible();
  await expect(helper.getByLabel('History').getByText('You accepted')).toBeVisible();

  // The first accept wins: the request leaves the list for everyone else.
  await helper.goto('/serve');
  await expect(helper.getByRole('region', { name: "You're helping" })).toContainText(summary);
  await expect(helper.getByRole('region', { name: 'Open requests' })).not.toContainText(summary);
  await helper.getByRole('link', { name: 'Open case' }).click();

  // The requester sees who accepted (the status card polls the request every 15 seconds).
  await expect(requester.page.getByText('Dee R. accepted your request.')).toBeVisible({
    timeout: 40_000,
  });

  // Chat, both ways, through the WebSocket push and with no reload on either side.
  const requesterSocket = recordSocket(requester.page);
  const helperSocket = recordSocket(helper);
  await requester.page.getByRole('link', { name: 'Message' }).click();
  await helper.getByRole('link', { name: 'Open chat with Marcus' }).click();
  await expect(requester.page).toHaveURL(new RegExp(`/chat/${requestId}$`));
  await expect(helper).toHaveURL(new RegExp(`/chat/${requestId}$`));
  for (const page of [requester.page, helper]) {
    await expect(
      page.getByRole('heading', { name: page === helper ? 'Marcus T.' : 'Dee R.' }),
    ).toBeVisible();
    await page.evaluate(() => {
      (window as unknown as { __stillHere: boolean }).__stillHere = true;
    });
  }
  // Both pages have opened their push connection before the first message is sent.
  await expect.poll(requesterSocket.opened).toBeGreaterThan(0);
  await expect.poll(helperSocket.opened).toBeGreaterThan(0);

  const hello = `Hi Marcus, I can drive you. ${uniqueEmail('m').slice(6, 12)}`;
  await helper.getByLabel('Message Marcus T.').fill(hello);
  await helper.getByRole('button', { name: 'Send', exact: true }).click();
  const requesterHistory = requester.page.getByRole('region', { name: 'Message history' });
  await expect(requesterHistory).toContainText(hello);
  await expect
    .poll(() => requesterSocket.frames.some((f) => f.includes('chat.message') && f.includes(hello)))
    .toBe(true);

  const reply = `Thank you, see you at the library. ${uniqueEmail('n').slice(6, 12)}`;
  await requester.page.getByLabel('Message Dee R.').fill(reply);
  await requester.page.getByRole('button', { name: 'Send', exact: true }).click();
  const helperHistory = helper.getByRole('region', { name: 'Message history' });
  await expect(helperHistory).toContainText(reply);
  await expect
    .poll(() => helperSocket.frames.some((f) => f.includes('chat.message') && f.includes(reply)))
    .toBe(true);
  await shoot(requester.page, '02-chat-requester');
  await shoot(helper, '02-chat-helper');

  for (const page of [requester.page, helper]) {
    expect(
      await page.evaluate(() => (window as unknown as { __stillHere?: boolean }).__stillHere),
    ).toBe(true);
  }

  // Start → done on the helper side, confirm on the requester side.
  await helper.goto(`/serve/requests/${requestId}`);
  await helper.getByRole('button', { name: "I've started helping" }).click();
  await expect(helper.getByRole('region', { name: 'Progress' })).toContainText('In progress');
  await helper.getByRole('button', { name: 'Mark as done' }).click();
  await expect(helper.getByRole('region', { name: 'Progress' })).toContainText('Marked as done');

  await requester.page.goto(`/requests/${requestId}`);
  await expect(requester.page.getByText('Dee R. marked this request as done.')).toBeVisible();
  await requester.page.getByRole('button', { name: "Confirm it's done" }).click();
  await expect(requester.page.getByText('You confirmed this request is done.')).toBeVisible();

  // The helper closes the confirmed request (DISPATCH.md §14.2); it leaves "You're helping".
  await helper.goto(`/serve/requests/${requestId}`);
  await helper.getByRole('button', { name: 'Close this request' }).click();
  await expect(helper.getByRole('region', { name: 'Progress' })).toContainText('Closed');
  await helper.goto('/serve');
  await expect(helper.getByRole('region', { name: 'Your summary' })).toContainText(
    /Closed in the last 30 days\s*1/,
  );
  await expect(helper.getByRole('region', { name: "You're helping" })).not.toContainText(summary);
});
