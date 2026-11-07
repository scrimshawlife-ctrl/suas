import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { nodeEngineIssue } from '../../scripts/node-engine.js';

const range = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    engines: { node: string };
  }
).engines.node;

describe('web Node engine', () => {
  it('rejects Node 22.0 and versions below the locked jsdom engine', () => {
    expect(range).toBe('>=22.22.2');
    expect(nodeEngineIssue('22.0.0', range)).toMatch(/not supported/);
    expect(nodeEngineIssue('22.21.0', range)).toMatch(/not supported/);
    expect(nodeEngineIssue('22.22.2', range)).toBeUndefined();
    expect(nodeEngineIssue(process.version, range)).toBeUndefined();
  });
});
