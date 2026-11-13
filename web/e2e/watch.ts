/**
 * Records every console error, uncaught page error, failed request and 5xx response on every
 * page of a browser context, so "no console errors" is checked, not eyeballed. Ported from the
 * QA sweep; the global fixture (fixtures.ts) attaches it to every context a test opens.
 */

import { expect, type BrowserContext, type Page } from '@playwright/test';

export type Problem = { kind: 'console' | 'pageerror' | 'requestfailed' | 'http5xx'; text: string };

/** Expected noise a test may allow by pattern, e.g. a 4xx the test provokes on purpose. */
export type Allow = RegExp[];

export function watchContext(context: BrowserContext, problems: Problem[]): void {
  const attach = (page: Page) => {
    page.on('console', (message) => {
      if (message.type() === 'error') {
        problems.push({ kind: 'console', text: `${page.url()} :: ${message.text()}` });
      }
    });
    page.on('pageerror', (error) => {
      problems.push({ kind: 'pageerror', text: `${page.url()} :: ${error.message}` });
    });
    page.on('requestfailed', (request) => {
      const reason = request.failure()?.errorText ?? 'unknown';
      // A navigation away aborts in-flight requests; that is not a defect.
      if (reason.includes('ERR_ABORTED') || reason.includes('NS_BINDING_ABORTED')) return;
      problems.push({
        kind: 'requestfailed',
        text: `${request.method()} ${request.url()} :: ${reason}`,
      });
    });
    page.on('response', (response) => {
      if (response.status() >= 500) {
        problems.push({
          kind: 'http5xx',
          text: `${response.request().method()} ${response.url()} :: ${String(response.status())}`,
        });
      }
    });
  };
  context.pages().forEach(attach);
  context.on('page', attach);
}

/** Fails with every recorded problem that no `allow` pattern matches. */
export function expectClean(problems: Problem[], allow: Allow = []): void {
  const left = problems.filter((p) => !allow.some((pattern) => pattern.test(p.text)));
  expect(
    left.map((p) => `[${p.kind}] ${p.text}`),
    'console, page errors, failed requests and 5xx',
  ).toEqual([]);
}

/**
 * Every visible link and button on the page with no real target: href missing, "#",
 * "javascript:" or empty, and buttons with no accessible name (the QA dead-control sweep).
 */
export async function deadControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const found: string[] = [];
    const visible = (el: Element) => {
      const box = (el as HTMLElement).getBoundingClientRect();
      return box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    };
    document.querySelectorAll('a').forEach((a) => {
      if (!visible(a)) return;
      const href = a.getAttribute('href');
      if (href === null || href === '' || href === '#' || href.startsWith('javascript:')) {
        found.push(`link "${(a.textContent ?? '').trim()}" href=${String(href)}`);
      }
    });
    document.querySelectorAll('button, [role="button"]').forEach((b) => {
      if (!visible(b)) return;
      const name = (b.getAttribute('aria-label') ?? b.textContent ?? '').trim();
      if (name === '') found.push(`button with no name: ${b.outerHTML.slice(0, 120)}`);
    });
    return found;
  });
}
