import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { JsonWebKey } from 'node:crypto';
import type { SuasConfig } from '../../config/index.js';
import {
  authorizationUrl,
  consumeVaOAuthTransaction,
  createVaOAuthTransaction,
  createVaOAuthTransactionRecord,
  hashesMatch,
  pkceChallenge,
  recordVaSandboxVerification,
  VaSandboxVeteranVerificationAdapter,
} from '../../identity/index.js';
import { authenticate } from '../authenticate.js';

const COOKIE = '__Host-suas-va-pkce';
const MAX_AGE_SECONDS = 10 * 60;

function cookieVerifier(request: { headers: { cookie?: string | undefined } }): string | undefined {
  const value = request.headers.cookie
    ?.split(';')
    .map((part) => part.trim().split('='))
    .find(([key]) => key === COOKIE)?.[1];
  if (value === undefined || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  try {
    const verifier = Buffer.from(value, 'base64url').toString('utf8');
    return /^[A-Za-z0-9_-]{43,128}$/.test(verifier) ? verifier : undefined;
  } catch {
    return undefined;
  }
}

interface EnabledVaConfig {
  clientId: string;
  clientSecret: string;
  authorizationEndpoint: string;
  redirectUri: string;
  tokenEndpoint: string;
  statusEndpoint: string;
  issuer: string;
  audience: string;
  jwks: JsonWebKey[];
}
function enabledConfig(config: SuasConfig): EnabledVaConfig {
  const va = config.vaSandboxOAuth;
  if (
    !va.enabled ||
    !va.clientId ||
    !va.clientSecret ||
    !va.authorizationEndpoint ||
    !va.redirectUri ||
    !va.tokenEndpoint ||
    !va.statusEndpoint ||
    !va.issuer ||
    !va.audience ||
    !va.jwksJson
  )
    throw new Error('VA sandbox OAuth configuration is incomplete');
  return {
    clientId: va.clientId,
    clientSecret: va.clientSecret,
    authorizationEndpoint: va.authorizationEndpoint,
    redirectUri: va.redirectUri,
    tokenEndpoint: va.tokenEndpoint,
    statusEndpoint: va.statusEndpoint,
    issuer: va.issuer,
    audience: va.audience,
    jwks: JSON.parse(va.jwksJson) as JsonWebKey[],
  };
}

/** D-035 evidence route. Call this only after the explicit config gate passes. */
export function registerVaSandboxOAuthRoutes(
  app: FastifyInstance,
  deps: { pool: Pool; config: SuasConfig; sessionSecret: string | undefined },
): void {
  const va = enabledConfig(deps.config);
  // The configured redirect URI is passed verbatim through the whole flow. It
  // is never inferred from an inbound request or provider endpoint.
  app.get('/auth/va/onboarding', async (request, reply) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    const transaction = createVaOAuthTransaction(va.redirectUri);
    await createVaOAuthTransactionRecord(deps.pool, {
      tenantId: context.tenantId,
      userId: context.userId,
      state: transaction.state,
      codeVerifier: transaction.codeVerifier,
      redirectUri: va.redirectUri,
      expiresAt: new Date(transaction.createdAt + MAX_AGE_SECONDS * 1000),
    });
    const verifier = Buffer.from(transaction.codeVerifier).toString('base64url');
    return reply
      .header('cache-control', 'no-store')
      .header('referrer-policy', 'no-referrer')
      .header(
        'set-cookie',
        `${COOKIE}=${verifier}; Path=/; Max-Age=${MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Lax`,
      )
      .redirect(
        authorizationUrl({
          authorizationEndpoint: va.authorizationEndpoint,
          clientId: va.clientId,
          transaction,
          codeChallenge: await pkceChallenge(transaction.codeVerifier),
        }),
      );
  });

  app.get('/auth/va/callback', async (request, reply) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    const query = request.query as { code?: string; state?: string; error?: string };
    const code = query.code;
    const state = query.state;
    const verifier = cookieVerifier(request);
    if (query.error || !code || !state || !verifier)
      return reply
        .status(400)
        .header('cache-control', 'no-store')
        .send({
          error: {
            code: 'VA_SANDBOX_CALLBACK_REJECTED',
            message: 'The VA sandbox authorization response could not be accepted.',
          },
        });
    const transaction = await consumeVaOAuthTransaction(deps.pool, {
      state,
      tenantId: context.tenantId,
      userId: context.userId,
    });
    if (!transaction || !hashesMatch(verifier, transaction.codeVerifierHash))
      return reply
        .status(400)
        .header('cache-control', 'no-store')
        .header('set-cookie', `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`)
        .send({
          error: {
            code: 'VA_SANDBOX_CALLBACK_REJECTED',
            message: 'The VA sandbox authorization response could not be accepted.',
          },
        });
    try {
      const result = await new VaSandboxVeteranVerificationAdapter({
        clientId: va.clientId,
        clientSecret: va.clientSecret,
        tokenEndpoint: va.tokenEndpoint,
        statusEndpoint: va.statusEndpoint,
        issuer: va.issuer,
        audience: va.audience,
        jwks: va.jwks,
      }).verifyVeteranStatus({
        veteranId: transaction.userId,
        authorizationCode: code,
        redirectUri: transaction.redirectUri,
        codeVerifier: verifier,
      });
      await recordVaSandboxVerification(deps.pool, {
        tenantId: transaction.tenantId,
        userId: transaction.userId,
        result,
      });
      return reply
        .status(303)
        .header('cache-control', 'no-store')
        .header('referrer-policy', 'no-referrer')
        .header('set-cookie', `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`)
        .redirect('/app/veteran?va_sandbox_verification=recorded');
    } catch {
      return reply
        .status(502)
        .header('cache-control', 'no-store')
        .header('set-cookie', `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`)
        .send({
          error: {
            code: 'VA_SANDBOX_VERIFICATION_UNAVAILABLE',
            message: 'VA sandbox verification is temporarily unavailable.',
          },
        });
    }
  });
}
