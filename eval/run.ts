/**
 * `npm run eval [-- --suite <name>] [-- --json]`: scores every suite with the
 * configured inference adapter and prints the result. Reporting only; the exit
 * code is 0 unless the harness itself fails (gates are undecided, plan §8 #13).
 *
 * Adapter: `SUAS_MODEL_INFERENCE_MODE`. CI sets `fake` (scripted baseline, scores
 * check the harness only). A real run needs a non-LOCAL/TEST environment with
 * `SUAS_MODEL_INFERENCE_MODE=bedrock`, `SUAS_AWS_REGION` and the model id set, and
 * sends only the synthetic cases to Bedrock. With no env at all it defaults to the
 * synthetic TEST environment and the fake.
 */

import { loadConfig, type ConfigSource } from '../src/config/index.js';
import { createModelInferencePort, ScriptedModelInference } from '../src/inference/index.js';
import { validEnv } from '../tests/helpers/env.js';
import { formatReport, type SuiteReport } from './harness.js';
import { SUITES } from './suites.js';

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const env: ConfigSource =
    process.env.SUAS_ENV === undefined
      ? validEnv({ SUAS_MODEL_INFERENCE_MODE: 'fake' })
      : process.env;
  const config = loadConfig(env);
  const probe = createModelInferencePort(config);
  if (!probe.isAvailable()) {
    console.error(
      'Model inference is not available (SUAS_MODEL_INFERENCE_MODE=disabled, or bedrock with no model).',
    );
    process.exitCode = 1;
    return;
  }
  // A scripted fake keeps a queue, so each case gets a fresh one; a real adapter is shared.
  const makeInference =
    probe instanceof ScriptedModelInference ? () => new ScriptedModelInference() : () => probe;

  const only = argValue('--suite');
  const suites = SUITES.filter((suite) => only === undefined || suite.name === only);
  if (suites.length === 0) {
    console.error(
      `No suite named "${only ?? ''}". Known: ${SUITES.map((s) => s.name).join(', ')}.`,
    );
    process.exitCode = 1;
    return;
  }

  const reports: SuiteReport[] = [];
  for (const suite of suites) reports.push(await suite.run(makeInference));

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ implementation: probe.implementation, reports }, null, 2));
  } else {
    console.log(formatReport(reports, probe.implementation));
  }
  if (reports.some((report) => report.errors.length > 0)) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.name : 'eval failed');
  process.exitCode = 1;
});
