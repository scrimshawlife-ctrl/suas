import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { nodeEngineIssue } from '../../scripts/node-engine.js';

const rootRange = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    engines: { node: string };
  }
).engines.node;

describe('declared Node engine', () => {
  it('rejects Node 22.0 and accepts the declared minimum', () => {
    expect(rootRange).toBe('>=22.13.0');
    expect(nodeEngineIssue('22.0.0', rootRange)).toBe(
      'Node 22.0.0 is not supported. This package requires Node >=22.13.0.',
    );
    expect(nodeEngineIssue('22.12.0', rootRange)).toMatch(/not supported/);
    expect(nodeEngineIssue('22.13.0', rootRange)).toBeUndefined();
    expect(nodeEngineIssue(process.version, rootRange)).toBeUndefined();
  });
});
