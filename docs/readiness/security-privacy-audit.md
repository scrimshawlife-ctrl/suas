# Security / privacy audit — SPEC-018 working evidence

**Scope:** repository implementation on stack `0.2.0`  
**Date:** 2026-08-27
**Claim boundary:** code and test evidence only. No HIPAA or legal compliance claim.

## Findings

| ID   | Severity   | Area                         | Status             | Notes                                                                                                                                                                                                                                              |
| ---- | ---------- | ---------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S-01 | Medium     | Auth abuse                   | Covered            | Challenge issuance is rate-limited (`RATE_LIMITED` / 429). HTTP evidence in `http-security.test.ts`. Limits remain `INFERRED` (AUTH.md / SECURITY.md).                                                                                             |
| S-02 | Medium     | Tenant isolation             | Covered            | Resources, consents, veterans/me refuse cross-tenant rows with identical 404/empty semantics.                                                                                                                                                      |
| S-03 | Low        | Existence leakage            | Covered            | Inactive/foreign resources → `NOT_FOUND`; auth challenge does not enumerate users (existing http-auth tests).                                                                                                                                      |
| S-04 | Low        | Secret redaction             | Covered            | Health and error bodies omit session secrets and DB URLs; Fastify redacts Authorization / cookie / idempotency headers.                                                                                                                            |
| S-05 | Medium     | Safety copy                  | Covered            | Immediate-resources JSON fail-closed to placeholder unless `SUAS_SAFETY_COPY_MODE=approved`.                                                                                                                                                       |
| S-06 | Info       | Dependency vulns             | Residual           | `npm audit` reports vitest/vite/esbuild GHSA-67mh (dev-server advisory). Production runtime deps (`fastify`, `pg`, `zod`) show no advisory in the same report. Vitest major upgrade deferred (breaking).                                           |
| S-07 | Medium     | CSRF / cookie auth           | N/A for bearer     | API uses bearer session credentials, not cookie session for `/api/v0`. HTML `/app` also bearer-via-header in tests.                                                                                                                                |
| S-08 | High (ops) | Durable jobs                 | Covered in STAGING | D-022 Postgres outbox is live on formal synthetic STAGING and passed the pinned soak. PRODUCTION remains closed under SPEC-018.                                                                                                                    |
| S-09 | Medium     | Automated emergency dispatch | Covered by design  | No PSAP/911 API call path; D-012 destinations are `tel:` display only.                                                                                                                                                                             |
| S-10 | Medium     | Deletion / retention         | Partial            | D-007 STAGING policy is decided: soft-delete the operational row, revoke sessions, and retain event/audit/consent history for 365 days. STAGING rehearsal passed. Production purge/export remains deferred. No HIPAA or provider-side erase claim. |

## Repairs in this sprint

- Scoring fail-closed for absent `questionnaireVersion` and `disabled` mode (#59)
- Resources / immediate-resources / veterans/me / consents JSON with authz
- Health dependency posture without secrets (#62)
- Adversarial HTTP suite: rate limit + tenant isolation + redaction
- D-022 Postgres-outbox worker and formal synthetic STAGING soak (85/85)
- D-007 synthetic deletion drill and STAGING rehearsal — request + soft-delete; event/audit/consent history retained for 365 days

## Explicit non-claims

- No production penetration test
- No third-party SOC evidence
- No legal compliance attestation
- No claim that inferred auth constants are released decisions
