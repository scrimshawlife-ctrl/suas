# SPEC-018 readiness plan (runtime working draft)

Canonical specs remain in `suas-specs`. This document tracks runtime evidence toward SPEC-018 go/no-go.

## Frontier (verified on main `e8d3082`)

- Spec stack pin: `0.2.0`
- Formal readiness: `NOT_READY` (no gate marked `READY` without TESTING.md evidence)
- Scoring fail-closed: absent/mismatched `qv-001` refused; `disabled` refuses every exported scoring path (#59/#67)
- JSON `/api/v0`: auth, check-ins, cases/claim/assign/resolve, settlements reads, resources, immediate-resources, veterans/me, consents grant/revoke, trusted-circle, SR create/commands, follow-ups, notifications inbox/preferences, admin adapters; OpenAPI + CI drift
- Durable jobs: port + LOCAL/TEST fake + conformance suite; STAGING/PRODUCTION fail-closed pending D-022
- Security/privacy audit + adversarial HTTP tests; runbooks; synthetic load + migration rehearse + deletion drill scripts

## Classification snapshot

| Item                                              | Class                                                                        |
| ------------------------------------------------- | ---------------------------------------------------------------------------- |
| Released sync Plane A JSON (auth → notifications) | CODE_FIXABLE — **done**                                                      |
| OpenAPI keep-in-sync                              | CODE_FIXABLE — **done** (CI drift check)                                     |
| Durable job vendor                                | OWNER_DECISION_REQUIRED (D-022)                                              |
| Staging topology / cloud account                  | OWNER_DECISION_REQUIRED / EXTERNAL_DEPENDENCY (D-001/D-005)                  |
| SLO / RTO / RPO thresholds                        | OWNER_DECISION_REQUIRED (D-021/D-023/D-024) → `NOT_COMPUTABLE` until decided |
| Staging soak / human UI–a11y baseline             | EVIDENCE_FIXABLE (needs staging or human review)                             |
| Real provider effects                             | INTENTIONALLY_UNAVAILABLE until production authorization                     |
| Mobile clients                                    | INTENTIONALLY_UNAVAILABLE this sprint                                        |

## Residual work (not CODE_FIXABLE product gaps)

1. Owner decides D-022 (recommended: Postgres outbox first).
2. Owner decides D-001/D-005 staging hosting.
3. Owner decides D-021/D-023/D-024 envelopes (or keep SCALE `NOT_COMPUTABLE`).
4. Eng runs staging soak + human UI baseline once staging exists.
5. Optional tooling: vitest/esbuild GHSA (dev-only).
6. Owner decides D-007 retention/deletion durations; staging rehearsal of the synthetic deletion drill. PRIVACY stays `NOT_READY`.

## Terminal rule

Do not mark a gate `READY` without TESTING.md evidence. Prefer `SPEC_018_BLOCKED_WITH_MINIMAL_RESIDUAL_SET` over false readiness.

## Settlement

Terminal outcome recorded in `SPEC-018-final-report.md`:
`SPEC_018_BLOCKED_WITH_MINIMAL_RESIDUAL_SET`.
