# SPEC-018 readiness plan (runtime working draft)

Canonical specs remain in `suas-specs`. This document tracks runtime evidence toward SPEC-018 go/no-go.

## Frontier (verified on main)

- Spec stack pin: `0.2.0`
- Formal readiness: `NOT_READY` (all 12 gates remain `NOT_READY` / pending evidence)
- Scoring fail-closed: absent/mismatched `qv-001` refused; `disabled` mode refuses `computeSignal` (#59)
- JSON `/api/v0`: auth, check-ins, cases/claim, resources, immediate-resources, veterans/me, admin adapters; OpenAPI + CI drift (#60–#61)
- Durable jobs: port + LOCAL/TEST fake; STAGING/PRODUCTION fail-closed pending D-022

## Classification snapshot

| Item                                                                          | Class                                                                                       |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Remaining Plane A JSON (consent, service-requests, notifications, follow-ups) | CODE_FIXABLE                                                                                |
| OpenAPI keep-in-sync                                                          | CODE_FIXABLE (done for current routes)                                                      |
| Durable job vendor                                                            | OWNER_DECISION_REQUIRED (D-022)                                                             |
| Staging topology / cloud account                                              | OWNER_DECISION_REQUIRED / EXTERNAL_DEPENDENCY                                               |
| SLO / RTO / RPO thresholds                                                    | OWNER_DECISION_REQUIRED (D-021/D-023/D-024) → formal verdict `NOT_COMPUTABLE` until decided |
| Real provider effects                                                         | INTENTIONALLY_UNAVAILABLE until production authorization                                    |
| Mobile clients                                                                | INTENTIONALLY_UNAVAILABLE this sprint                                                       |

## Next CODE_FIXABLE slices

1. Consent-visible + service-request read/command JSON where released
2. Security/privacy adversarial test pack + dependency audit script
3. Synthetic load/resilience harness scripts (no invented SLO pass/fail)
4. Migration/restore rehearsal scripts + runbooks
5. Gate evidence matrix filled from CI artifacts

## Terminal rule

Do not mark a gate `READY` without TESTING.md evidence. Prefer `SPEC_018_BLOCKED_WITH_MINIMAL_RESIDUAL_SET` over false readiness.
