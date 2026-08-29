import { randomBytes, timingSafeEqual } from 'node:crypto';

export const VA_SANDBOX_SCOPES = ['openid', 'profile', 'veteran_status.read'] as const;
export type VaSandboxScope = (typeof VA_SANDBOX_SCOPES)[number];

export interface VaOAuthTransaction {
  state: string;
  codeVerifier: string;
  redirectUri: string;
  createdAt: number;
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

export function createVaOAuthTransaction(
  redirectUri: string,
  now = Date.now(),
): VaOAuthTransaction {
  const state = base64url(randomBytes(32));
  const codeVerifier = base64url(randomBytes(32));
  return { state, codeVerifier, redirectUri, createdAt: now };
}

export async function pkceChallenge(codeVerifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
  return base64url(new Uint8Array(digest));
}

export function assertOAuthCallbackState(
  expected: VaOAuthTransaction,
  receivedState: string,
  redirectUri: string,
  now = Date.now(),
  maxAgeMs = 10 * 60 * 1000,
): void {
  const left = Buffer.from(expected.state);
  const right = Buffer.from(receivedState);
  if (left.length !== right.length || !timingSafeEqual(left, right))
    throw new Error('OAuth state mismatch');
  if (expected.redirectUri !== redirectUri) throw new Error('OAuth redirect URI mismatch');
  if (now - expected.createdAt < 0 || now - expected.createdAt > maxAgeMs)
    throw new Error('OAuth transaction expired');
}

export function authorizationUrl(input: {
  authorizationEndpoint: string;
  clientId: string;
  transaction: VaOAuthTransaction;
  codeChallenge: string;
}): string {
  const url = new URL(input.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.transaction.redirectUri);
  url.searchParams.set('scope', VA_SANDBOX_SCOPES.join(' '));
  url.searchParams.set('state', input.transaction.state);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}
