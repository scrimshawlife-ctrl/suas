/**
 * Workflow inputs that decide what CI runs. verify.yml checks out `inputs.ref` when
 * staging-deploy.yml calls it, so every job that does must first reject anything but a full
 * commit SHA: the deploy then verifies exactly the commit it ships, never a branch or tag that
 * can move. Python packages the workflows install are pinned to an exact version for the same
 * reason. Reads the workflows as text (no network) and runs the guard's own shell line with bash.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const WORKFLOWS = new URL('../../.github/workflows/', import.meta.url);
const read = (name: string) => readFileSync(new URL(name, WORKFLOWS), 'utf8');
const WORKFLOW = read('verify.yml');

const CHECKOUTS = WORKFLOW.match(/^\s+ref: \$\{\{ inputs\.ref \}\}$/gm) ?? [];

// The guard step, then the checkout of inputs.ref it protects.
const GUARDED_CHECKOUT =
  /- name: Require a full commit SHA for inputs\.ref\n\s+env:\n\s+REF: \$\{\{ inputs\.ref \}\}\n\s+run: \|\n\s+(.+)\n\s+- uses: actions\/checkout@.+\n\s+with:\n\s+ref: \$\{\{ inputs\.ref \}\}\n/g;

const guards = [...WORKFLOW.matchAll(GUARDED_CHECKOUT)].map((match) => match[1] ?? '');

const accepts = (guard: string, ref: string) =>
  spawnSync('bash', ['-e', '-c', guard], { env: { REF: ref } }).status === 0;

describe('verify.yml inputs.ref guard', () => {
  it('runs right before every checkout of inputs.ref', () => {
    expect(CHECKOUTS).toHaveLength(3);
    expect(guards).toHaveLength(CHECKOUTS.length);
    expect(new Set(guards).size).toBe(1);
  });

  it.each([
    ['', true],
    ['c5989ed879822063fe83b260e01498a628c3074a', true],
    ['main', false],
    ['refs/heads/main', false],
    ['c5989ed8', false],
    ['C5989ED879822063FE83B260E01498A628C3074A', false],
    ['c5989ed879822063fe83b260e01498a628c3074a0', false],
    ['c5989ed879822063fe83b260e01498a628c3074a\nmain', false],
  ])('ref %j accepted: %s', (ref, ok) => {
    expect(guards.length).toBeGreaterThan(0);
    for (const guard of guards) expect(accepts(guard, ref)).toBe(ok);
  });
});

describe('workflow Python packages', () => {
  // `uv run --with NAME` and `pip install NAME` install whatever is newest unless pinned.
  const installs = readdirSync(WORKFLOWS)
    .filter((name) => name.endsWith('.yml'))
    .flatMap((name) =>
      [...read(name).matchAll(/(?:--with|pip install) +(\S+)/g)].map((m) => `${name}: ${m[1]}`),
    );

  it('pins every installed package to an exact version', () => {
    expect(installs.length).toBeGreaterThan(0);
    expect(installs.filter((install) => !/==\d+(\.\d+)*$/.test(install))).toEqual([]);
  });
});
