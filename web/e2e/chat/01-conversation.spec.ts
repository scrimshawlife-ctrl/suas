/**
 * One conversation between a Veteran and the helper who took their request: empty and very long
 * messages, older messages paging, Back/Forward between threads, send order and phone width.
 * Ported from the QA sweep's serve/03-chat; unread badges are multi/m5.
 */

import { expect, test } from '../fixtures';
import { shoot } from '../helpers';
import { PHONE, newHelper, newRequester, sendRequest, tag, take } from '../serve/serve';
import { history, pair, say, threadLink } from './chat';

test.describe.configure({ timeout: 180_000 });

test('empty messages cannot be sent, a 2000-character message goes through whole, and refresh keeps it', async ({
  browser,
  request,
}) => {
  const { requester, helper: page, id } = await pair(browser, request);
  await page.goto(`/chat/${id}`);
  await expect(page).toHaveTitle('Chat · SUAS');
  await expect(page.getByRole('heading', { name: 'Marcus T.' })).toBeVisible();
  await expect(history(page)).toContainText('You accepted this request on');

  const box = page.getByLabel('Message Marcus T.');
  const send = page.getByRole('button', { name: 'Send', exact: true });
  await expect(send).toBeDisabled();
  await box.fill('   \n  ');
  await expect(send).toBeDisabled();

  // The count shows near the limit, and the box stops at 2000 characters.
  const long = `Start ${tag()} ${'word '.repeat(500)}`.slice(0, 2000);
  await box.fill(long.slice(0, 1800));
  await expect(page.getByText('1800 of 2000 characters')).toBeVisible();
  await box.fill(`${long}EXTRA`);
  expect((await box.inputValue()).length).toBeLessThanOrEqual(2000);
  await box.fill(long);
  await expect(page.getByText('2000 of 2000 characters')).toBeVisible();
  await send.click();
  await expect(box).toHaveValue('');
  await expect(history(page).getByText('Sending', { exact: true })).toHaveCount(0);

  // Lines are kept as typed.
  const lines = `First line ${tag()}\nSecond line`;
  await say(page, 'Marcus T.', lines);

  await requester.goto(`/chat/${id}`);
  await expect(history(requester).getByText(long.trim())).toBeVisible();
  await expect(history(requester).getByText(lines)).toBeVisible();
  await page.reload();
  await expect(history(page).getByText(long.trim())).toBeVisible();
  await expect(history(page).getByText(lines)).toBeVisible();
  await shoot(page, 'chat-01-long');
});

test('many messages: the newest is in view, earlier ones load on request, and refresh starts at the newest', async ({
  browser,
  request,
}) => {
  const { requester, helper: page, id } = await pair(browser, request);
  await page.goto(`/chat/${id}`);
  const run = tag();
  // One more page than the client reads at once (50), sent one after another as a person types.
  const total = 55;
  for (let n = 1; n <= total; n += 1) await say(page, 'Marcus T.', `Note ${String(n)} of ${run}`);
  await expect(history(page).getByText(`Note ${String(total)} of ${run}`)).toBeInViewport();

  await requester.goto(`/chat/${id}`);
  await expect(history(requester).getByText(`Note ${String(total)} of ${run}`)).toBeInViewport();
  await expect(history(requester).getByText(`Note 1 of ${run}`, { exact: true })).toHaveCount(0);
  const earlier = history(requester).getByRole('button', { name: 'Load earlier messages' });
  await earlier.click();
  await expect(history(requester).getByText(`Note 1 of ${run}`, { exact: true })).toBeAttached();
  await expect(earlier).toHaveCount(0);
  await expect(history(requester)).toContainText('Dee R. accepted your request on');
  // Every message appears once, in order.
  const texts = await history(requester).getByRole('listitem').allInnerTexts();
  const order = texts
    .map((t) => /Note (\d+) of/.exec(t)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number);
  expect(order).toEqual(Array.from({ length: total }, (_, i) => i + 1));

  await requester.reload();
  await expect(history(requester).getByText(`Note ${String(total)} of ${run}`)).toBeInViewport();
  await expect(
    history(requester).getByRole('button', { name: 'Load earlier messages' }),
  ).toBeVisible();
});

test('a helper with two chats moves between them with Back and Forward, and the title leads to the case', async ({
  browser,
  request,
}) => {
  const first = await newRequester(browser, request, { name: 'Marcus T.' });
  const a = await sendRequest(first, request);
  const second = await newRequester(browser, request, { name: 'Rosa M.' });
  const b = await sendRequest(second, request);
  const { page } = await newHelper(browser, request, { name: 'Dee R.' });
  await take(page, a.summary, a.id);
  await take(page, b.summary, b.id);

  await page.goto('/chat');
  await expect(threadLink(page, /Marcus T\./)).toBeVisible();
  await expect(threadLink(page, /Rosa M\./)).toBeVisible();
  await threadLink(page, /Marcus T\./).click();
  await expect(page).toHaveURL(new RegExp(`/chat/${a.id}$`));
  await say(page, 'Marcus T.', `Hello Marcus ${tag()}`);
  await threadLink(page, /Rosa M\./).click();
  await expect(page).toHaveURL(new RegExp(`/chat/${b.id}$`));
  await expect(page.getByRole('heading', { name: 'Rosa M.' })).toBeVisible();
  await expect(threadLink(page, /Rosa M\./)).toHaveAttribute('aria-current', 'page');

  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/chat/${a.id}$`));
  await expect(page.getByRole('heading', { name: 'Marcus T.' })).toBeVisible();
  await expect(page.getByLabel('Message Marcus T.')).toBeVisible();
  await page.goForward();
  await expect(page.getByRole('heading', { name: 'Rosa M.' })).toBeVisible();
  // The request title in the chat header leads to the helper's case page.
  await page.getByRole('link', { name: b.summary, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/serve/requests/${b.id}$`));
});

test('two messages sent one right after the other arrive in the order they were typed', async ({
  browser,
  request,
}) => {
  // SERVE-6: the outbox sends one POST at a time, so a slow first send cannot be stored second.
  const { requester, helper: page, id } = await pair(browser, request);
  await page.goto(`/chat/${id}`);
  const first = `First: I'm outside ${tag()}`;
  const second = `Second: by the blue door ${tag()}`;
  // A slow network for the first send only (page.route, the slow-network case).
  let delayed = false;
  await page.route(`**/api/v0/service-requests/${id}/chat/messages`, async (route) => {
    if (route.request().method() === 'POST' && !delayed) {
      delayed = true;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
    await route.continue();
  });
  await page.getByLabel('Message Marcus T.').fill(first);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByLabel('Message Marcus T.').fill(second);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(history(page).getByText('Sending', { exact: true })).toHaveCount(0);

  await requester.goto(`/chat/${id}`);
  const items = history(requester).getByRole('listitem');
  await expect(items.filter({ hasText: second })).toHaveCount(1);
  const texts = await items.allInnerTexts();
  const at = (text: string) => texts.findIndex((t) => t.includes(text));
  expect(at(first), 'the first message is above the second').toBeLessThan(at(second));
});

test('on a phone the chat shows the list, then one conversation with a way back', async ({
  browser,
  request,
}) => {
  const { helper: page, id } = await pair(browser, request, { helperViewport: PHONE });
  await page.goto('/chat');
  await expect(threadLink(page, /Marcus T\./)).toBeVisible();
  await expect(page.getByText('Choose a conversation to read it.')).toBeHidden();
  await threadLink(page, /Marcus T\./).click();
  await expect(page).toHaveURL(new RegExp(`/chat/${id}$`));
  await expect(threadLink(page, /Marcus T\./)).toBeHidden();
  const text = `On my way ${tag()}`;
  await say(page, 'Marcus T.', text);
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await shoot(page, 'chat-01-phone');
  await page.getByRole('link', { name: 'All conversations' }).click();
  await expect(page).toHaveURL(/\/chat$/);
  await expect(threadLink(page, /Marcus T\./)).toContainText(text);
});
