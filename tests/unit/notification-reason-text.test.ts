/**
 * Every notification reason the server sends has a plain sentence in the web app, and the web
 * map names no reason the server never sends. Sign-in codes (`auth.*`) are hidden by the web.
 */

import { describe, expect, it } from 'vitest';
import {
  REQUEST_EXPIRED_REASON,
  REQUEST_RELEASED_REASON,
} from '../../src/coordination/request-notices.js';
import { EMAIL_TEMPLATE_KEYS } from '../../src/notifications/templates.js';

const SERVER_REASONS = [
  ...new Set([
    ...EMAIL_TEMPLATE_KEYS.map((key) => key.reason),
    REQUEST_EXPIRED_REASON,
    REQUEST_RELEASED_REASON,
  ]),
].filter((reason) => !reason.startsWith('auth.'));

// Loaded by URL like ui-contract.test.ts does: the web package has its own tsconfig.
async function webReasonText(): Promise<Readonly<Record<string, string>>> {
  const url = new URL('../../web/src/features/support/notification-reasons.ts', import.meta.url);
  const module = (await import(url.href)) as { REASON_TEXT: Readonly<Record<string, string>> };
  return module.REASON_TEXT;
}

describe('web notification reason text', () => {
  it('words every reason in templates.ts and the request notices', async () => {
    const text = await webReasonText();
    for (const reason of SERVER_REASONS) {
      expect(text[reason], reason).toMatch(/\S/);
    }
  });

  it('names no reason the server does not send', async () => {
    expect(Object.keys(await webReasonText()).sort()).toEqual([...SERVER_REASONS].sort());
  });
});
