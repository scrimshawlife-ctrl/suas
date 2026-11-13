/** The UI ↔ /api/v0 traceability gate (scripts/ui-coverage.ts): its scan and `--check` rules. */

import { describe, expect, it } from 'vitest';
import {
  buildRows,
  checkFailures,
  scanCallers,
  type Operation,
} from '../../scripts/ui-coverage.js';

const op = (id: string, method: string, path: string): Operation => ({
  id,
  method,
  path,
  statuses: ['200'],
});

const operations = [
  op('getThing', 'GET', '/api/v0/things/{id}'),
  op('publishThing', 'POST', '/api/v0/things/{id}/commands/publish'),
  op('getHealth', 'GET', '/api/v0/health'),
  op('orphan', 'GET', '/api/v0/orphan'),
];

const source = [
  "const a = await api.GET('/api/v0/things/{id}', { params });",
  'const b = await api.POST(',
  "  '/api/v0/things/{id}/commands/publish',",
  '  { params },',
  ');',
].join('\n');

describe('ui-coverage', () => {
  it('finds literal call sites, including a path on the next line', () => {
    const callers = scanCallers([{ file: 'src/a.ts', text: source }]);
    expect(callers.get('GET /api/v0/things/{id}')).toEqual(['src/a.ts:1']);
    expect(callers.get('POST /api/v0/things/{id}/commands/publish')).toEqual(['src/a.ts:2']);
  });

  it('fails on an unclassified op, a called UI-less op, an unhit caller and a stale entry', () => {
    const uiLess = {
      getHealth: { reason: 'probe', ref: 'x' },
      publishThing: { reason: 'none', ref: 'x' },
      removedOp: { reason: 'gone', ref: 'x' },
    };
    const callers = scanCallers([{ file: 'src/a.ts', text: source }]);
    const hits = [{ operationId: 'publishThing', status: 200, pageRoute: '/things/1' }];
    expect(checkFailures(buildRows(operations, callers, uiLess, hits), uiLess)).toEqual([
      'removedOp: listed in ui-less.json but not in the OpenAPI document',
      'getThing: called but never hit from a page in e2e',
      'publishThing: listed as UI-less but called at src/a.ts:2',
      'orphan: no web caller and not in ui-less.json',
    ]);
  });

  it('passes when every op is called and hit, or listed as UI-less', () => {
    const uiLess = { getHealth: { reason: 'probe', ref: 'x' }, orphan: { reason: 'x', ref: 'x' } };
    const callers = scanCallers([{ file: 'src/a.ts', text: source }]);
    const hits = ['getThing', 'publishThing'].map((operationId) => ({
      operationId,
      status: 200,
      pageRoute: '/',
    }));
    expect(checkFailures(buildRows(operations, callers, uiLess, hits), uiLess)).toEqual([]);
  });
});
