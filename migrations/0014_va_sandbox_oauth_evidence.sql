-- 0014_va_sandbox_oauth_evidence.sql — D-035 sandbox-only OAuth evidence.
-- This schema deliberately stores neither authorization codes, access tokens,
-- ID tokens, raw VA payloads, nor VA identifiers. PKCE verifier/state values
-- are represented only by SHA-256 hashes. The verifier itself stays in a
-- short-lived signed HttpOnly browser cookie and is checked against its hash.

CREATE TABLE va_oauth_transactions (
    transaction_id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    state_hash text NOT NULL UNIQUE,
    code_verifier_hash text NOT NULL,
    redirect_uri text NOT NULL,
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (user_id, tenant_id) REFERENCES users (user_id, tenant_id),
    CHECK (expires_at > created_at)
);
CREATE INDEX va_oauth_transactions_live_state_idx
    ON va_oauth_transactions (state_hash, expires_at)
    WHERE consumed_at IS NULL;

CREATE TYPE suas_veteran_verification_method AS ENUM
    ('VA_VETERAN_STATUS', 'SELF_ATTESTATION', 'MANUAL_REVIEW');
CREATE TYPE suas_veteran_verification_status AS ENUM
    ('VERIFIED', 'NOT_CONFIRMED', 'PENDING', 'UNAVAILABLE', 'REVOKED');
CREATE TYPE suas_va_not_confirmed_reason AS ENUM
    ('PERSON_NOT_FOUND', 'NOT_TITLE_38', 'MORE_RESEARCH_REQUIRED', 'ERROR');

-- A normalized result projection, never a copy of a provider response.
CREATE TABLE veteran_verifications (
    verification_id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    method suas_veteran_verification_method NOT NULL,
    status suas_veteran_verification_status NOT NULL,
    source text NOT NULL CHECK (source IN ('VA', 'SUAS')),
    source_contract_version text NOT NULL,
    verified_at timestamptz,
    not_confirmed_reason suas_va_not_confirmed_reason,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (user_id, tenant_id) REFERENCES users (user_id, tenant_id),
    CHECK ((status = 'VERIFIED' AND verified_at IS NOT NULL) OR status <> 'VERIFIED'),
    CHECK ((status = 'NOT_CONFIRMED' AND not_confirmed_reason IS NOT NULL) OR status <> 'NOT_CONFIRMED')
);
CREATE INDEX veteran_verifications_subject_idx
    ON veteran_verifications (tenant_id, user_id, created_at DESC);
