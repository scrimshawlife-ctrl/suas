import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const webDir = resolve(import.meta.dirname, '..');
const playwrightCli = createRequire(import.meta.url).resolve('@playwright/test/cli');

// The only specs allowed to run before 03-widening: they leave no open request on the boards
// it checks (San Mateo, Alameda). Add one here only after checking that.
const safeBeforeWidening = ['01-request-through-assistant.spec.ts', '02-accept-and-chat.spec.ts'];

/** Spec files in the order Playwright runs them, from its own `--list` (no servers start). */
function e2eSpecOrder(): string[] {
  const json = execFileSync(
    process.execPath,
    [playwrightCli, 'test', '-c', 'playwright.e2e.config.ts', '--list', '--reporter=json'],
    { cwd: webDir, encoding: 'utf8' },
  );
  const report = JSON.parse(json) as { suites: { file: string }[] };
  return report.suites.map((suite) => suite.file);
}

describe('web e2e spec order', () => {
  // 03-widening expects other counties' boards to be empty, so nothing that leaves open
  // requests may run before it. A shard runs a contiguous slice of this order on its own
  // database, so an order that holds here holds in every shard.
  it('runs 03-widening after only the specs known to leave the boards empty', () => {
    const order = e2eSpecOrder();
    const widening = order.indexOf('03-widening.spec.ts');
    expect(widening).toBeGreaterThanOrEqual(0);
    expect(order.slice(0, widening)).toEqual(safeBeforeWidening);
  }, 60_000);
});
