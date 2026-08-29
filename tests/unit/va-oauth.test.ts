import { describe, expect, it } from 'vitest';
import {
  assertOAuthCallbackState,
  authorizationUrl,
  createVaOAuthTransaction,
  pkceChallenge,
  VA_SANDBOX_SCOPES,
} from '../../src/identity/va-oauth.js';

describe('VA sandbox OAuth evidence helpers', () => {
  it('uses the exact approved scope set and S256 PKCE', async () => {
    const transaction = createVaOAuthTransaction('https://staging.example/auth/va/callback', 1000);
    const challenge = await pkceChallenge(transaction.codeVerifier);
    const url = new URL(
      authorizationUrl({
        authorizationEndpoint: 'https://sandbox.example/authorize',
        clientId: 'sandbox-client',
        transaction,
        codeChallenge: challenge,
      }),
    );
    expect(url.searchParams.get('scope')).toBe(VA_SANDBOX_SCOPES.join(' '));
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe(challenge);
    expect(await pkceChallenge(transaction.codeVerifier)).toMatch(/^[A-Za-z0-9_-]+$/);
  });
  it('binds callback state and redirect URI and rejects replay-age violations', () => {
    const transaction = createVaOAuthTransaction('https://staging.example/auth/va/callback', 1000);
    expect(() =>
      assertOAuthCallbackState(transaction, transaction.state, transaction.redirectUri, 2000),
    ).not.toThrow();
    expect(() =>
      assertOAuthCallbackState(transaction, 'wrong', transaction.redirectUri, 2000),
    ).toThrow('state mismatch');
    expect(() =>
      assertOAuthCallbackState(transaction, transaction.state, transaction.redirectUri, 700001),
    ).toThrow('expired');
  });
});
