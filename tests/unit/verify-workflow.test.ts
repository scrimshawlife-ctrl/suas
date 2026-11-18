/**
 * Workflow inputs that decide what CI runs. verify.yml checks out `inputs.ref` when
 * staging-deploy.yml calls it, so every job that does must first reject anything but a full
 * commit SHA: the deploy then verifies exactly the commit it ships, never a branch or tag that
 * can move, and a caller cannot leave it empty. Only verify.yml's own push, pull_request and
 * dispatch runs check out their triggering commit. Python packages the workflows install are
 * pinned to an exact version for the same reason, and secrets reach only the step that reads
 * them. Reads the workflows as text (no network) and runs the guard's own shell line with bash.
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
  /- name: Require a full commit SHA for inputs\.ref\n\s+env:\n\s+REF: \$\{\{ inputs\.ref \}\}\n(?: +#[^\n]*\n)?\s+WORKFLOW_REF: \$\{\{ github\.workflow_ref \}\}\n\s+run: \|\n\s+(.+)\n\s+- uses: actions\/checkout@.+\n\s+with:\n\s+ref: \$\{\{ inputs\.ref \}\}\n/g;

const guards = [...WORKFLOW.matchAll(GUARDED_CHECKOUT)].map((match) => match[1] ?? '');

// In a called workflow, github.workflow_ref names the caller (staging-deploy.yml), not verify.yml.
const OWN_RUN = 'scrimshawlife-ctrl/suas/.github/workflows/verify.yml@refs/pull/322/merge';
const CALLED = 'scrimshawlife-ctrl/suas/.github/workflows/staging-deploy.yml@refs/heads/main';

const accepts = (guard: string, ref: string, workflowRef: string) =>
  spawnSync('bash', ['-e', '-c', guard], { env: { REF: ref, WORKFLOW_REF: workflowRef } })
    .status === 0;

describe('verify.yml inputs.ref guard', () => {
  it('runs right before every checkout of inputs.ref', () => {
    expect(CHECKOUTS).toHaveLength(3);
    expect(guards).toHaveLength(CHECKOUTS.length);
    expect(new Set(guards).size).toBe(1);
  });

  it('makes callers pass ref', () => {
    expect(WORKFLOW).toMatch(
      /workflow_call:\n +inputs:\n +ref:\n(?: +(?!default)[a-z#][^\n]*\n)*? +required: true\n/,
    );
  });

  it.each([
    ['', OWN_RUN, true],
    ['', CALLED, false],
    ['c5989ed879822063fe83b260e01498a628c3074a', OWN_RUN, true],
    ['c5989ed879822063fe83b260e01498a628c3074a', CALLED, true],
    ['main', CALLED, false],
    ['refs/heads/main', CALLED, false],
    ['c5989ed8', CALLED, false],
    ['C5989ED879822063FE83B260E01498A628C3074A', CALLED, false],
    ['c5989ed879822063fe83b260e01498a628c3074a0', CALLED, false],
    ['c5989ed879822063fe83b260e01498a628c3074a\nmain', CALLED, false],
  ])('ref %j from %s accepted: %s', (ref, workflowRef, ok) => {
    expect(guards.length).toBeGreaterThan(0);
    for (const guard of guards) expect(accepts(guard, ref, workflowRef)).toBe(ok);
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

describe('workflow secrets', () => {
  // A secret in workflow or job env reaches every step, including `npm ci` install scripts and
  // third-party actions. Each secret is read only inside the step that needs it.
  const indent = (line: string) => line.length - line.trimStart().length;
  const outsideSteps = readdirSync(WORKFLOWS)
    .filter((name) => name.endsWith('.yml'))
    .flatMap((name) => {
      const lines = read(name).split('\n');
      return lines.flatMap((line, at) => {
        if (!line.includes('secrets.')) return [];
        // Walk the YAML ancestors; a step is a list item under `steps:`.
        let depth = indent(line);
        for (let i = at - 1; i >= 0; i -= 1) {
          const parent = lines[i]!;
          if (parent.trim() === '' || parent.trimStart().startsWith('#')) continue;
          if (indent(parent) >= depth) continue;
          if (parent.trimStart().startsWith('- ')) return [];
          depth = indent(parent);
        }
        return [`${name}:${at + 1}: ${line.trim()}`];
      });
    });

  it('exposes each secret only to the step that uses it', () => {
    expect(outsideSteps).toEqual([]);
  });
});
