import type { JsonWebKey } from 'node:crypto';
import {
  normalizeVaVeteranStatus,
  type VeteranVerificationPort,
  type VeteranVerificationResult,
  type VaNotConfirmedReason,
} from './veteran-verification.js';
import { VA_SANDBOX_SCOPES } from './va-oauth.js';

export interface VaSandboxTransport {
  fetch(input: string | URL, init?: RequestInit): Promise<Response>;
}
export interface VaSandboxConfig {
  clientId: string;
  clientSecret: string;
  tokenEndpoint: string;
  statusEndpoint: string;
  issuer: string;
  audience: string;
  jwks: JsonWebKey[];
}
type Jwt = {
  alg?: string;
  kid?: string;
  iss?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
  veteran_status?: string;
  status?: string;
  not_confirmed_reason?: VaNotConfirmedReason;
};

function decodePart(value: string): Uint8Array {
  const normalized = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(normalized), (char) => char.charCodeAt(0));
}
function decodeJson(value: string): Jwt {
  return JSON.parse(new TextDecoder().decode(decodePart(value))) as Jwt;
}
function audienceMatches(aud: Jwt['aud'], expected: string): boolean {
  return aud === expected || (Array.isArray(aud) && aud.includes(expected));
}

async function verifyJwt(token: string, config: VaSandboxConfig): Promise<Jwt> {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2])
    throw new Error('VA JWT must have three segments');
  const header = decodeJson(parts[0]);
  const payload = decodeJson(parts[1]);
  if (
    header.alg !== 'RS256' ||
    !header.kid ||
    !payload.iss ||
    payload.iss !== config.issuer ||
    !audienceMatches(payload.aud, config.audience) ||
    typeof payload.exp !== 'number' ||
    payload.exp <= Math.floor(Date.now() / 1000)
  )
    throw new Error('VA JWT claims rejected');
  const jwk = config.jwks.find((candidate) => candidate.kid === header.kid);
  if (!jwk) throw new Error('VA JWT signing key unavailable');
  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    decodePart(parts[2]),
    new TextEncoder().encode(parts[0] + '.' + parts[1]),
  );
  if (!valid) throw new Error('VA JWT signature rejected');
  return payload;
}

export class VaSandboxVeteranVerificationAdapter implements VeteranVerificationPort {
  constructor(
    private readonly config: VaSandboxConfig,
    private readonly transport: VaSandboxTransport = globalThis,
  ) {}
  async verifyVeteranStatus(input: {
    veteranId: string;
    authorizationCode: string;
    redirectUri: string;
    codeVerifier?: string;
  }): Promise<VeteranVerificationResult> {
    if (!input.codeVerifier) throw new Error('PKCE code verifier is required');
    const tokenResponse = await this.transport.fetch(this.config.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: input.authorizationCode,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        redirect_uri: input.redirectUri,
        code_verifier: input.codeVerifier,
      }).toString(),
    });
    if (!tokenResponse.ok) throw new Error('VA token exchange failed');
    const tokenBody = (await tokenResponse.json()) as { access_token?: string; id_token?: string };
    if (!tokenBody.access_token || !tokenBody.id_token)
      throw new Error('VA token response missing required tokens');
    await verifyJwt(tokenBody.id_token, this.config);
    const statusResponse = await this.transport.fetch(this.config.statusEndpoint, {
      headers: { authorization: 'Bearer ' + tokenBody.access_token, accept: 'application/json' },
    });
    if (!statusResponse.ok) throw new Error('VA status request failed');
    const status = (await statusResponse.json()) as {
      veteran_status?: 'confirmed' | 'not confirmed';
      status?: 'confirmed' | 'not confirmed';
      not_confirmed_reason?: VaNotConfirmedReason;
    };
    const veteranStatus = status.veteran_status ?? status.status;
    if (veteranStatus !== 'confirmed' && veteranStatus !== 'not confirmed')
      return {
        status: 'UNAVAILABLE',
        sourceContractVersion: 'VA_SERVICE_HISTORY_ELIGIBILITY_STATUS_ONLY',
      };
    return normalizeVaVeteranStatus({
      veteranStatus,
      ...(status.not_confirmed_reason ? { notConfirmedReason: status.not_confirmed_reason } : {}),
      sourceContractVersion: 'VA_SERVICE_HISTORY_ELIGIBILITY_STATUS_ONLY',
    });
  }
}

export { VA_SANDBOX_SCOPES };
