/**
 * The suite's `test`: every browser context a test opens (its `page` and each `newPerson`) is
 * watched for console errors, page errors, failed requests and 5xx, and every `/api/v0`
 * response is checked against the OpenAPI document and logged for `npm run ui:coverage`.
 */

import { expect, test as base, type BrowserContext, type Response } from '@playwright/test';
import { checkResponse, recordHit } from './contract';
import { expectClean, watchContext, type Allow, type Problem } from './watch';

export { expect };

/** Closes a context, ignoring only the error for one that is already closed. */
async function closeOpen(context: BrowserContext): Promise<void> {
  try {
    await context.close();
  } catch (error) {
    if (!/has been closed/.test(String(error))) throw error;
  }
}

export const test = base.extend<{ allow: Allow; guard: void }>({
  /** Patterns of expected noise for this test: `allow.push(/status of 409/)`. */
  // eslint-disable-next-line no-empty-pattern
  allow: async ({}, provide) => {
    await provide([]);
  },
  // Depends on `context` so it is torn down, and checks run, before Playwright closes it.
  guard: [
    async ({ browser, context, allow }, provide, testInfo) => {
      const problems: Problem[] = [];
      const violations: string[] = [];
      const pending: Promise<void>[] = [];
      const opened: BrowserContext[] = [];
      const testName = testInfo.titlePath.join(' > ');

      const watched: { context: BrowserContext; onResponse: (response: Response) => void }[] = [];
      const watch = (target: BrowserContext) => {
        watchContext(target, problems);
        const onResponse = (response: Response) => {
          const pageRoute = new URL(response.frame().url()).pathname;
          pending.push(
            checkResponse(response)
              .then((result) => {
                if (result === undefined) return;
                if (result.problem !== undefined) violations.push(result.problem);
                if (result.operationId === '?') return;
                const { problem: _problem, ...hit } = result;
                recordHit(
                  { ...hit, status: response.status(), pageRoute, test: testName },
                  testInfo.workerIndex,
                );
              })
              .catch((error: unknown) => {
                violations.push(`${response.url()}: ${String(error)}`);
              }),
          );
        };
        target.on('response', onResponse);
        watched.push({ context: target, onResponse });
      };
      const onContext = (created: BrowserContext) => {
        opened.push(created);
        watch(created);
      };

      watch(context);
      browser.on('context', onContext);
      await provide();
      // Stop listening first: polls after this point belong to no test and are not checked.
      browser.off('context', onContext);
      for (const { context: target, onResponse } of watched) target.off('response', onResponse);

      while (pending.length > 0) await pending.shift();
      const seen = [...problems];
      const broken = [...violations];
      // Extra contexts would otherwise keep polling into later tests. One the test (or a timeout)
      // already closed is skipped; any other close failure still fails the test.
      await Promise.all(opened.map(closeOpen));
      expect(broken, 'responses that break docs/openapi/v0.json').toEqual([]);
      expectClean(seen, allow);
    },
    { auto: true },
  ],
});
