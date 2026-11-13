/**
 * Manual Gmail SMTP smoke test (suas-specs #75 R11.2, proposal): sends one test email
 * straight to smtp.gmail.com with the developer's own app password. Not run in CI.
 *
 * Reads SUAS_SMTP_USER and SUAS_SMTP_APP_PASSWORD from the environment and refuses
 * SUAS_ENV=PRODUCTION. The recipient comes from --to or a prompt (a prompt keeps it out of
 * shell history). Prints only the result class and SMTP reply code: never the password,
 * the recipient or the server's reply text.
 *
 *   node --env-file-if-exists=.env --import tsx/esm src/cli/gmail-smtp-smoke.ts [--to address]
 */

import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { GmailSmtpSender } from '../notifications/gmail-smtp-sender.js';
import { smtpMessageId } from '../notifications/smtp.js';

function required(name: 'SUAS_SMTP_USER' | 'SUAS_SMTP_APP_PASSWORD'): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === '') throw new Error(`Set ${name} to run this.`);
  return value;
}

async function recipient(): Promise<string> {
  const { values } = parseArgs({ options: { to: { type: 'string' } }, strict: true });
  if (typeof values.to === 'string' && values.to.trim() !== '') return values.to.trim();
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await prompt.question('Send the test email to: ')).trim();
  } finally {
    prompt.close();
  }
}

async function main(): Promise<void> {
  if (process.env.SUAS_ENV === 'PRODUCTION') {
    throw new Error('Refused: the Gmail SMTP smoke test never runs with SUAS_ENV=PRODUCTION.');
  }
  const sender = new GmailSmtpSender({
    user: required('SUAS_SMTP_USER'),
    appPassword: required('SUAS_SMTP_APP_PASSWORD'),
  });
  const to = await recipient();
  if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(to))
    throw new Error('That is not an email address.');

  const result = await sender.send({
    to,
    subject: 'SUAS Gmail SMTP smoke test',
    text: 'This is a SUAS Gmail SMTP smoke test. No action is needed.',
    messageId: smtpMessageId(`gmail-smtp-smoke:${randomUUID()}`),
  });
  console.log(
    JSON.stringify({ result: result.result, response_code: result.responseCode ?? null }),
  );
  if (result.result !== 'sent') process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Gmail SMTP smoke test failed.');
  process.exitCode = 1;
});
