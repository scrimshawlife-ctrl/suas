/**
 * Field-level contract check: every `/api/v0` response a page receives must use a status that
 * docs/openapi/v0.json documents for its operation and match that schema (OpenAPI 3.1 is JSON
 * Schema 2020-12). Each response is also logged for `npm run ui:coverage` (plan §4, C3).
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Response } from '@playwright/test';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

type OpenApiResponse = { $ref?: string; content?: Record<string, unknown> };
type OpenApi = {
  paths: Record<
    string,
    Record<string, { operationId?: string; responses?: Record<string, OpenApiResponse> }>
  >;
};
type Operation = {
  id: string;
  method: string;
  template: string;
  pattern: RegExp;
  responses: Record<string, OpenApiResponse>;
};

export type Hit = {
  operationId: string;
  command?: string;
  status: number;
  pageRoute: string;
  test: string;
};

const COVERAGE_DIR = resolve(import.meta.dirname, '..', 'e2e-results', 'coverage');
const openapi = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '..', '..', 'docs', 'openapi', 'v0.json'), 'utf8'),
) as OpenApi;
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(openapi, 'oa');

// Fewest path parameters first, so `/commands/edit` wins over `/commands/{command}`.
const operations: Operation[] = Object.entries(openapi.paths)
  .flatMap(([template, methods]) =>
    Object.entries(methods)
      .filter(([, op]) => op.operationId !== undefined)
      .map(([method, op]) => ({
        id: op.operationId ?? '',
        method: method.toUpperCase(),
        template,
        pattern: new RegExp(`^${template.replace(/\{[^}]+\}/g, '[^/]+')}$`),
        responses: op.responses ?? {},
      })),
  )
  .sort((a, b) => a.template.split('{').length - b.template.split('{').length);

const pointer = (op: Operation, status: string): string | undefined => {
  const response = op.responses[status];
  if (response?.$ref !== undefined) return `${response.$ref}/content/application~1json/schema`;
  if (response?.content?.['application/json'] === undefined) return undefined;
  const path = op.template.replace(/~/g, '~0').replace(/\//g, '~1');
  return `#/paths/${path}/${op.method.toLowerCase()}/responses/${status}/content/application~1json/schema`;
};

const BODY_READ_MS = 10_000;

/**
 * The response body, or a rejection after BODY_READ_MS: a request the page navigated away from
 * can leave `response.text()` pending until its context closes, which would hang the teardown.
 */
async function readBody(response: Response): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('body read timed out'));
    }, BODY_READ_MS);
  });
  try {
    return await Promise.race([response.text(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Checks one response. Returns undefined for anything outside the contract (assets, dev and
 * mocked routes), else the operation, the `{command}` path value if any, and any problem.
 */
export async function checkResponse(
  response: Response,
): Promise<{ operationId: string; command?: string; problem?: string } | undefined> {
  const { pathname } = new URL(response.url());
  if (!pathname.startsWith('/api/v0/') || pathname.startsWith('/api/v0/dev/')) return undefined;
  // A `page.route` fulfilment has no server address: it is a mock, not the real backend.
  if ((await response.serverAddr()) === null) return undefined;
  const method = response.request().method();
  const label = `${method} ${pathname} ${String(response.status())}`;
  const op = operations.find((o) => o.method === method && o.pattern.test(pathname));
  if (op === undefined) return { operationId: '?', problem: `${label}: no OpenAPI operation` };

  const commandIndex = op.template.split('/').indexOf('{command}');
  const command = commandIndex === -1 ? undefined : pathname.split('/')[commandIndex];
  const result = { operationId: op.id, ...(command === undefined ? {} : { command }) };
  const status = String(response.status());
  if (op.responses[status] === undefined) {
    return { ...result, problem: `${label}: status not documented for ${op.id}` };
  }
  const schemaPointer = pointer(op, status);
  if (schemaPointer === undefined) return result;

  let text: string;
  try {
    text = await readBody(response);
  } catch {
    // The body is gone when the page navigated or closed first; the status was still checked.
    return result;
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ...result, problem: `${label}: body is not JSON: ${text.slice(0, 120)}` };
  }
  const validate = ajv.getSchema(`oa${schemaPointer}`);
  if (validate === undefined)
    return { ...result, problem: `${label}: no schema at ${schemaPointer}` };
  if (validate(body)) return result;
  return { ...result, problem: `${label}: ${ajv.errorsText(validate.errors)}` };
}

/** Appends one page-originated hit to this worker's coverage log. */
export function recordHit(hit: Hit, workerIndex: number): void {
  mkdirSync(COVERAGE_DIR, { recursive: true });
  appendFileSync(
    resolve(COVERAGE_DIR, `worker-${String(workerIndex)}.jsonl`),
    `${JSON.stringify(hit)}\n`,
  );
}
