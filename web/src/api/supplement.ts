/**
 * TEMPORARY typed supplement for what docs/openapi/v0.json does not describe yet.
 *
 * Delete this file (and the `Omit`/merge in client-types.ts) once the `api` branch lands:
 *  - auth challenge, verify and logout have no request or response schemas, and the
 *    document lists 200 where the server answers 202, 201 and 204;
 *  - GET /veterans/me lacks `display_name` and `is_admin`;
 *  - PUT /veterans/me/profile does not exist in the document.
 * Shapes follow the web decisions file (verified against feature_v1_backend on 2026-11-04).
 */
import type { paths as GeneratedPaths } from './schema';

export type County =
  'SANTA_CLARA' | 'SAN_MATEO' | 'ALAMEDA' | 'SANTA_CRUZ' | 'SAN_BENITO' | 'MERCED' | 'STANISLAUS';

type MeBase =
  GeneratedPaths['/api/v0/veterans/me']['get']['responses']['200']['content']['application/json'];

/** GET /api/v0/veterans/me, with the fields the `api` branch is adding. */
export type MeResponse = MeBase & {
  display_name: string | null;
  is_admin: boolean;
};

export interface ChallengeRequest {
  destination: string;
  method: 'EMAIL_OTP';
}

export interface VerifyChallengeRequest {
  destination: string;
  code: string;
}

export interface SessionResponse {
  session_credential: string;
  expires_at: string;
  mfa_elevated: boolean;
}

export interface ProfileRequest {
  display_name: string;
}

interface Json<T> {
  content: { 'application/json': T };
}

interface Empty {
  content?: never;
}

/** Paths replaced by the supplement; the generated entries for these keys are dropped. */
export type SupplementedPath =
  | '/api/v0/auth/challenges'
  | '/api/v0/auth/challenges/commands/verify'
  | '/api/v0/auth/sessions/commands/logout'
  | '/api/v0/veterans/me'
  | '/api/v0/veterans/me/profile';

export interface SupplementPaths {
  '/api/v0/auth/challenges': {
    post: {
      requestBody: Json<ChallengeRequest>;
      responses: { 202: Empty };
    };
  };
  '/api/v0/auth/challenges/commands/verify': {
    post: {
      requestBody: Json<VerifyChallengeRequest>;
      responses: { 201: Json<SessionResponse> };
    };
  };
  '/api/v0/auth/sessions/commands/logout': {
    post: {
      responses: { 204: Empty };
    };
  };
  '/api/v0/veterans/me': {
    get: {
      responses: { 200: Json<MeResponse> };
    };
  };
  '/api/v0/veterans/me/profile': {
    put: {
      requestBody: Json<ProfileRequest>;
      responses: { 200: Json<{ display_name: string }> };
    };
  };
}
