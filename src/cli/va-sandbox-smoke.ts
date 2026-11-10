/**
 * Manual VA sandbox smoke test (suas-specs #72 R9.1, proposal): one confirm call with the
 * developer's own sandbox key and a VA sandbox test identity. Not run in CI.
 *
 * Reads SUAS_VA_CONFIRMATION_* from the environment and refuses unless the mode is
 * `sandbox`. Fields come from flags or prompts (prompts keep them out of shell history).
 * Prints only the normalized status, reason and failure class: never the key or inputs.
 *
 *   npm run va:sandbox-smoke -- [--first-name X --last-name X --birth-date YYYY-MM-DD
 *     --street X --city X --state X --zip X]
 */

import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { loadConfig } from '../config/index.js';
import { createVeteranConfirmationPort } from '../identity/va-confirmation-factory.js';
import { vaConfirmationRequestSchema } from '../identity/va-confirmation.js';

const FIELDS = [
  ['first-name', 'firstName', 'First name'],
  ['last-name', 'lastName', 'Last name'],
  ['birth-date', 'birthDate', 'Birth date (YYYY-MM-DD)'],
  ['street', 'streetAddressLine1', 'Street address line 1'],
  ['city', 'city', 'City'],
  ['state', 'state', 'State'],
  ['zip', 'zipCode', 'ZIP code'],
] as const;

async function readFields(): Promise<Record<string, string>> {
  const { values } = parseArgs({
    options: Object.fromEntries(FIELDS.map(([flag]) => [flag, { type: 'string' }])),
    strict: true,
  });
  const body: Record<string, string> = {};
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (const [flag, key, label] of FIELDS) {
      const given = values[flag];
      body[key] = typeof given === 'string' ? given : (await prompt.question(`${label}: `)).trim();
    }
  } finally {
    prompt.close();
  }
  return body;
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  if (config.vaConfirmation.mode !== 'sandbox') {
    throw new Error(
      'Set SUAS_VA_CONFIRMATION_MODE=sandbox (with its base URL and key) to run this.',
    );
  }
  const port = createVeteranConfirmationPort(config);
  if (port === undefined) throw new Error('The VA confirmation sandbox adapter is not configured.');

  const parsed = vaConfirmationRequestSchema.safeParse(await readFields());
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))];
    throw new Error(`These fields do not match the VA patterns: ${fields.join(', ')}.`);
  }

  const result = await port.confirm(parsed.data);
  console.log(
    JSON.stringify({
      status: result.status,
      not_confirmed_reason: result.notConfirmedReason ?? null,
      failure_class: result.failureClass ?? null,
    }),
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'VA sandbox smoke test failed.');
  process.exitCode = 1;
});
