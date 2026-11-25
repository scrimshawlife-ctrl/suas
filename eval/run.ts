/**
 * `npm run eval [-- --suite <name>] [-- --json]`: scores every suite with the
 * configured inference adapter and prints the result. Reporting only; the exit
 * code is 0 unless the harness itself fails (gates are undecided, plan §8 #13).
 *
 * Adapter: `SUAS_MODEL_INFERENCE_MODE`. CI sets `fake` (scripted baseline, scores
 * check the harness only). With no env at all it defaults to the synthetic TEST
 * environment and the fake.
 *
 * A real run (R17.6, contributor proposal, not released) sets `SUAS_ENV=STAGING`,
 * `SUAS_MODEL_INFERENCE_MODE=bedrock`, `SUAS_AWS_REGION`, `SUAS_BEDROCK_MODEL_ID` and,
 * to match STAGING, `SUAS_BEDROCK_GUARDRAIL_ID` + `_VERSION`. It builds the direct
 * Bedrock adapter here from those variables, as the relay function does, instead of
 * `loadConfig`: the API's STAGING config requires the in-VPC relay, which a laptop has
 * no use for. It sends only the synthetic cases to Bedrock and refuses any other class.
 */

import { loadConfig, type ConfigSource } from '../src/config/index.js';
import {
  BedrockModelInference,
  consoleInferenceLogger,
  createModelInferencePort,
  ScriptedModelInference,
  type ModelInferencePort,
} from '../src/inference/index.js';
import { validEnv } from '../tests/helpers/env.js';
import { formatReport, type SuiteReport } from './harness.js';
import { SUITES } from './suites.js';

/** The direct Bedrock adapter for a STAGING eval run, or why it cannot be built. */
function directBedrock(): ModelInferencePort | string {
  const env = process.env;
  if (env.SUAS_ENV !== 'STAGING') return 'A Bedrock eval runs only with SUAS_ENV=STAGING.';
  const region = env.SUAS_AWS_REGION;
  const modelId = env.SUAS_BEDROCK_MODEL_ID;
  if (!region || !modelId) return 'A Bedrock eval needs SUAS_AWS_REGION and SUAS_BEDROCK_MODEL_ID.';
  const guardrailId = env.SUAS_BEDROCK_GUARDRAIL_ID;
  const guardrailVersion = env.SUAS_BEDROCK_GUARDRAIL_VERSION;
  return new BedrockModelInference({
    modelId,
    region,
    logger: consoleInferenceLogger,
    ...(guardrailId && guardrailVersion
      ? { guardrail: { identifier: guardrailId, version: guardrailVersion } }
      : {}),
  });
}

function configuredPort(): ModelInferencePort | string {
  if (process.env.SUAS_MODEL_INFERENCE_MODE === 'bedrock') return directBedrock();
  const env: ConfigSource =
    process.env.SUAS_ENV === undefined
      ? validEnv({ SUAS_MODEL_INFERENCE_MODE: 'fake' })
      : process.env;
  return createModelInferencePort(loadConfig(env));
}

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const probe = configuredPort();
  if (typeof probe === 'string') {
    console.error(probe);
    process.exitCode = 1;
    return;
  }
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
