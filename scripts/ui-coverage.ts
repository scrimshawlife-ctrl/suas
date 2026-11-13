/**
 * UI ↔ `/api/v0` traceability. Every operation in docs/openapi/v0.json must be called by the
 * web app (`api.METHOD('/api/v0/…')` in web/src) or be listed in web/e2e/coverage/ui-less.json
 * with a reason. Runtime hits come from the e2e recorder (web/e2e-results/coverage/*.jsonl).
 *
 * `npm run ui:coverage` prints the table and exits 0; `-- --check` fails on any gap.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export type Operation = { id: string; method: string; path: string; statuses: string[] };
export type Hit = { operationId: string; command?: string; status: number; pageRoute: string };
export type UiLess = Record<string, { reason: string; ref: string }>;
export type Row = { op: Operation; callers: string[]; hits: Hit[]; uiLess: boolean };

const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);
const CALL_SITE = /api\.(GET|POST|PUT|PATCH|DELETE)\(\s*'(\/api\/v0\/[^']*)'/g;

export function readOperations(document: {
  paths: Record<string, Record<string, { operationId: string; responses?: object }>>;
}): Operation[] {
  return Object.entries(document.paths).flatMap(([path, methods]) =>
    Object.entries(methods)
      .filter(([method]) => METHODS.has(method))
      .map(([method, op]) => ({
        id: op.operationId,
        method: method.toUpperCase(),
        path,
        statuses: Object.keys(op.responses ?? {}),
      })),
  );
}

/** `file:line` of every literal-path API call, keyed by `METHOD /path`. */
export function scanCallers(files: { file: string; text: string }[]): Map<string, string[]> {
  const callers = new Map<string, string[]>();
  for (const { file, text } of files) {
    for (const match of text.matchAll(CALL_SITE)) {
      const line = text.slice(0, match.index).split('\n').length;
      const key = `${match[1] ?? ''} ${match[2] ?? ''}`;
      callers.set(key, [...(callers.get(key) ?? []), `${file}:${String(line)}`]);
    }
  }
  return callers;
}

export function buildRows(
  operations: Operation[],
  callers: Map<string, string[]>,
  uiLess: UiLess,
  hits: Hit[],
): Row[] {
  return operations.map((op) => ({
    op,
    callers: callers.get(`${op.method} ${op.path}`) ?? [],
    hits: hits.filter((hit) => hit.operationId === op.id),
    uiLess: op.id in uiLess,
  }));
}

/** The `--check` rules (plan §4): no unclassified op, no called UI-less op, no unhit caller. */
export function checkFailures(rows: Row[], uiLess: UiLess): string[] {
  const known = new Set(rows.map((row) => row.op.id));
  return [
    ...Object.keys(uiLess)
      .filter((id) => !known.has(id))
      .map((id) => `${id}: listed in ui-less.json but not in the OpenAPI document`),
    ...rows.flatMap(({ op, callers, hits, uiLess: listed }) => {
      if (callers.length === 0 && !listed)
        return [`${op.id}: no web caller and not in ui-less.json`];
      if (callers.length > 0 && listed)
        return [`${op.id}: listed as UI-less but called at ${callers.join(', ')}`];
      if (callers.length > 0 && hits.length === 0)
        return [`${op.id}: called but never hit from a page in e2e`];
      return [];
    }),
  ];
}

const tally = (values: (string | number | undefined)[]): string => {
  const counts = new Map<string, number>();
  for (const value of values)
    if (value !== undefined) counts.set(String(value), (counts.get(String(value)) ?? 0) + 1);
  return [...counts].map(([value, n]) => `${value}×${String(n)}`).join(', ');
};

export function renderReport(rows: Row[], uiLess: UiLess): string {
  const state = (row: Row) =>
    row.callers.length > 0 ? 'called' : row.uiLess ? 'ui-less' : 'UNCLASSIFIED';
  const lines = [
    '| Operation | Route | State | Web callers | e2e statuses | Commands | Documented |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows
      .map((row) =>
        [
          row.op.id,
          `${row.op.method} ${row.op.path.replace('/api/v0', '')}`,
          state(row),
          row.callers.join('<br>') || (uiLess[row.op.id]?.reason ?? ''),
          tally(row.hits.map((hit) => hit.status)),
          tally(row.hits.map((hit) => hit.command)),
          row.op.statuses.join(', '),
        ].join(' | '),
      )
      .map((line) => `| ${line} |`),
  ];
  const count = (predicate: (row: Row) => boolean) => String(rows.filter(predicate).length);
  lines.push(
    '',
    `${String(rows.length)} operations: ${count((r) => r.callers.length > 0)} called ` +
      `(${count((r) => r.callers.length > 0 && r.hits.length > 0)} hit from a page in e2e), ` +
      `${count((r) => r.callers.length === 0 && r.uiLess)} UI-less, ` +
      `${count((r) => r.callers.length === 0 && !r.uiLess)} unclassified.`,
  );
  return lines.join('\n');
}

function sourceFiles(dir: string, root: string): { file: string; text: string }[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter(
      (name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.startsWith('test/'),
    )
    .map((name) => ({
      file: relative(root, join(dir, name)),
      text: readFileSync(join(dir, name), 'utf8'),
    }));
}

function readHits(dir: string): Hit[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .flatMap((name) => readFileSync(join(dir, name), 'utf8').split('\n'))
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Hit);
}

function main(): void {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const read = (path: string): unknown => JSON.parse(readFileSync(join(root, path), 'utf8'));
  const operations = readOperations(
    read('docs/openapi/v0.json') as Parameters<typeof readOperations>[0],
  );
  const uiLess = read('web/e2e/coverage/ui-less.json') as UiLess;
  const rows = buildRows(
    operations,
    scanCallers(sourceFiles(join(root, 'web/src'), join(root, 'web'))),
    uiLess,
    readHits(join(root, 'web/e2e-results/coverage')),
  );
  console.log(renderReport(rows, uiLess));
  if (!process.argv.includes('--check')) return;
  const failures = checkFailures(rows, uiLess);
  for (const failure of failures) console.error(`ui-coverage: ${failure}`);
  if (failures.length > 0) process.exitCode = 1;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) main();
