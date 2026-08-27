# SPEC-018 readiness plan (runtime working draft)

Canonical specs remain in `suas-specs`. This document tracks runtime evidence toward SPEC-018 go/no-go.

## Frontier (verified through PR #111 and settlement HEAD `d73bc1c`)

- Spec stack pin: `0.2.0`
- Formal readiness: `NOT_READY` (no gate marked `READY` without TESTING.md evidence)
- Scoring fail-closed: absent/mismatched `qv-001` refused; `disabled` refuses every exported scoring path (#59/#67)
- JSON `/api/v0`: auth, check-ins, every `CASE_COMMANDS` verb + settlements, resources, immediate-resources, veterans/me, consents grant/revoke, trusted-circle, SR create/commands, follow-ups, notifications inbox/preferences, admin adapters; OpenAPI + CI drift; settle:check enum coverage
- Durable jobs: D-022 Postgres outbox is live on formal synthetic STAGING; LOCAL/TEST retain the declared fake; PRODUCTION remains closed under SPEC-018
- Security/privacy audit + adversarial HTTP tests; runbooks; synthetic load + migration rehearse + D-007 STAGING deletion rehearsal

## Classification snapshot

| Item                                              | Class                                                                        |
| ------------------------------------------------- | ---------------------------------------------------------------------------- |
| Released sync Plane A JSON (auth → notifications) | CODE_FIXABLE — **done**                                                      |
| OpenAPI keep-in-sync                              | CODE_FIXABLE — **done** (CI drift check)                                     |
| Durable job product                               | **done for STAGING** — D-022 Postgres outbox                                 |
| Staging topology / cloud account                  | **done for synthetic STAGING** — D-001/D-005                                 |
| SLO / RTO / RPO thresholds                        | OWNER_DECISION_REQUIRED (D-021/D-023/D-024) → `NOT_COMPUTABLE` until decided |
| Staging soak / human UI–a11y baseline             | 85/85 soak landed; human contrast/focus/reflow review remains                |
| D-007 retention/deletion                          | STAGING synthetic policy + rehearsal done; production purge/export deferred  |
| Real provider effects                             | INTENTIONALLY_UNAVAILABLE until production authorization                     |
| Mobile clients                                    | INTENTIONALLY_UNAVAILABLE this sprint                                        |

## Residual work (not CODE_FIXABLE product gaps)

1. Human reviews the pinned UI/a11y pack and Eng reruns it on STAGING.
2. Eng reviews STAGING in D-012 `approved` safety-copy mode without enabling dispatch.
3. Owner decides D-021/D-023/D-024 envelopes (or keeps SCALE `NOT_COMPUTABLE`), then Eng runs the restore rehearsal.
4. D-007 production purge/export remains separately owner-authorized; STAGING retains event/audit/consent history for 365 days and PRIVACY stays `NOT_READY`.
5. Owner decides D-025 reporting policy; sensitive aggregate reporting stays disabled.
6. Optional tooling: vitest/esbuild GHSA (dev-only).

## Terminal rule

Do not mark a gate `READY` without TESTING.md evidence. Prefer `SPEC_018_BLOCKED_WITH_MINIMAL_RESIDUAL_SET` over false readiness.

## Settlement

Terminal outcome recorded in `SPEC-018-final-report.md`:
`SPEC_018_BLOCKED_WITH_MINIMAL_RESIDUAL_SET`.
