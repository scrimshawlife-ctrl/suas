import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { nodeEngineIssue } from '../../scripts/node-engine.js';

const range = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    engines: { node: string };
  }
).engines.node;

describe('infra Node engine', () => {
  it('rejects Node 22.0 and 22.11, which the locked vitest and rolldown engines reject', () => {
    expect(range).toBe('>=22.12.0');
    expect(nodeEngineIssue('22.0.0', range)).toMatch(/not supported/);
    expect(nodeEngineIssue('22.11.9', range)).toMatch(/not supported/);
    expect(nodeEngineIssue('22.12.0', range)).toBeUndefined();
    expect(nodeEngineIssue(process.version, range)).toBeUndefined();
  });
});
