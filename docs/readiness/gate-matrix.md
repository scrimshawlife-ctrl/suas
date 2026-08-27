# Twelve-gate evidence matrix — SPEC-018

**Stack:** `0.2.0`  
**Runtime head:** full `CASE_COMMANDS` HTTP + Settlement reads (settle:check enum gate)  
**Verdict vocabulary:** `READY` | `NOT_READY` | `NOT_COMPUTABLE`

| Gate                 | Verdict        | Evidence                                                                  | Remaining blockers                                 | Owner                   | Smallest next action                                           | Blocks       |
| -------------------- | -------------- | ------------------------------------------------------------------------- | -------------------------------------------------- | ----------------------- | -------------------------------------------------------------- | ------------ |
| AUTH                 | NOT_READY      | HTTP auth + MFA; rate-limit adversarial (`http-security`); session revoke | Staging abuse SLO; inferred constants              | Eng + owner (constants) | Close AUTH constant D-0xx or accept inferred with release note | Pilot        |
| CONSENT              | NOT_READY      | Domain + consents list/grant/revoke + trusted-circle JSON                 | Staging soak; human policy review                  | Eng                     | Staging evidence under fixture mode                            | Pilot        |
| CHECK-IN             | NOT_READY      | HTTP start/answer/complete + scoring                                      | Staging soak                                       | Eng                     | Staging evidence under fixture mode                            | Pilot        |
| COORDINATION         | NOT_READY      | All CASE_COMMANDS over /api/v0; settlements; SR; follow-ups; veterans/me  | Durable async (D-022); staging soak                | Eng + owner             | D-022 durable adapter                                          | Pilot        |
| EXTERNAL_FULFILLMENT | NOT_READY      | Ports/fakes/manual; admin adapter config                                  | Real provider effects prohibited; vendor decisions | Owner                   | Keep UNAVAILABLE until authorized                              | Production   |
| UI_CONFORMANCE       | NOT_READY      | HTML surfaces + fixtures; LOCAL pinned pack `evidence/local-ui-a11y-2026-08-26/` (markup a11y 12/12; LH a11y 100 on home/responder) | Human contrast/focus/reflow review; STAGING re-run | Eng + human             | Human review of pinned screenshots; re-soak on STAGING after D-022 | Pilot        |
| SAFETY               | NOT_READY      | D-012 HTML + JSON immediate-resources; no dispatch                        | Approved copy mode ops checklist                   | Eng                     | Staging `approved` mode review                                 | Pilot        |
| PRIVACY              | NOT_READY      | Min-necessary projections; audit pack; synthetic deletion drill           | D-007 durations; staging rehearsal; no HIPAA claim | Eng + owner (D-007)     | D-007 retention durations + staging rehearsal of this drill    | Pilot        |
| SCALE                | NOT_COMPUTABLE | Bounded list drills exist                                                 | D-021/D-023 envelopes absent                       | Owner                   | Decide SLOs or keep NOT_COMPUTABLE                             | Production   |
| RESILIENCE           | NOT_READY      | `resilience-drills.test.ts`; job fail-closed                              | D-022 durable queue; D-024 RTO/RPO                 | Owner + eng             | Select D-022; restore rehearsal with durable queue             | Staging/Prod |
| OPERATIONS           | NOT_READY      | Health deps; provenance; migrate CLI; runbooks (this pack)                | Real staging topology                              | Owner (D-001/D-005)     | Approve staging environment                                    | Staging      |
| REPORTING            | NOT_READY      | Sensitive aggregate reporting disabled                                    | D-025 policy                                       | Owner                   | Decide D-025                                                   | Production   |

No gate is marked `READY`.
