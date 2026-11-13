/**
 * The suite's `test`: every browser context a test opens (its `page` and each `newPerson`) is
 * watched for console errors, page errors, failed requests and 5xx, and every `/api/v0`
 * response is checked against the OpenAPI document and logged for `npm run ui:coverage`.
 */

import { expect, test as base, type BrowserContext } from '@playwright/test';
import { checkResponse, recordHit } from './contract';
import { expectClean, watchContext, type Allow, type Problem } from './watch';

export { expect };

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

      const watch = (watched: BrowserContext) => {
        watchContext(watched, problems);
        watched.on('response', (response) => {
          const pageRoute = new URL(response.frame().url()).pathname;
          pending.push(
            checkResponse(response).then((result) => {
              if (result === undefined) return;
              if (result.problem !== undefined) violations.push(result.problem);
              if (result.operationId === '?') return;
              const { problem: _problem, ...hit } = result;
              recordHit(
                { ...hit, status: response.status(), pageRoute, test: testName },
                testInfo.workerIndex,
              );
            }),
          );
        });
      };
      const onContext = (created: BrowserContext) => {
        opened.push(created);
        watch(created);
      };

      watch(context);
      browser.on('context', onContext);
      await provide();
      browser.off('context', onContext);

      while (pending.length > 0) await pending.shift();
      const seen = [...problems];
      const broken = [...violations];
      // Extra contexts would otherwise keep polling into later tests.
      await Promise.all(opened.map((extra) => extra.close()));
      expect(broken, 'responses that break docs/openapi/v0.json').toEqual([]);
      expectClean(seen, allow);
    },
    { auto: true },
  ],
});
