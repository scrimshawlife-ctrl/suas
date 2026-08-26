# Twelve-gate evidence matrix — SPEC-018

**Stack:** `0.2.0`  
**Runtime head:** post `#63` (`410617e` lineage)  
**Verdict vocabulary:** `READY` | `NOT_READY` | `NOT_COMPUTABLE`

| Gate                 | Verdict        | Evidence                                                                  | Remaining blockers                                 | Owner                   | Smallest next action                                           | Blocks       |
| -------------------- | -------------- | ------------------------------------------------------------------------- | -------------------------------------------------- | ----------------------- | -------------------------------------------------------------- | ------------ |
| AUTH                 | NOT_READY      | HTTP auth + MFA; rate-limit adversarial (`http-security`); session revoke | Staging abuse SLO; inferred constants              | Eng + owner (constants) | Close AUTH constant D-0xx or accept inferred with release note | Pilot        |
| CONSENT              | NOT_READY      | Domain + consents list/grant/revoke + trusted-circle JSON                 | Staging soak; human policy review                  | Eng                     | Staging evidence under fixture mode                            | Pilot        |
| CHECK-IN             | NOT_READY      | HTTP start/answer/complete + scoring (#57/#59)                            | Staging synthetic soak                             | Eng                     | Staging soak under fixture mode                                | Pilot        |
| COORDINATION         | NOT_READY      | Cases list/claim; SR reads; veterans/me                                   | SR write commands; durable async (D-022)           | Eng + owner             | D-022 + SR command JSON                                        | Pilot        |
| EXTERNAL_FULFILLMENT | NOT_READY      | Ports/fakes/manual; admin adapter config                                  | Real provider effects prohibited; vendor decisions | Owner                   | Keep UNAVAILABLE until authorized                              | Production   |
| UI_CONFORMANCE       | NOT_READY      | HTML reference surfaces + fixtures                                        | Human a11y / visual baseline                       | Eng + human             | Pinned baseline review                                         | Pilot        |
| SAFETY               | NOT_READY      | D-012 HTML + JSON immediate-resources; no dispatch                        | Approved copy mode ops checklist                   | Eng                     | Staging `approved` mode review                                 | Pilot        |
| PRIVACY              | NOT_READY      | Min-necessary projections; audit doc                                      | Formal retention/deletion rehearsal                | Eng                     | Deletion drill script against synthetic DB                     | Pilot        |
| SCALE                | NOT_COMPUTABLE | Bounded list drills exist                                                 | D-021/D-023 envelopes absent                       | Owner                   | Decide SLOs or keep NOT_COMPUTABLE                             | Production   |
| RESILIENCE           | NOT_READY      | `resilience-drills.test.ts`; job fail-closed                              | D-022 durable queue; D-024 RTO/RPO                 | Owner + eng             | Select D-022; restore rehearsal with durable queue             | Staging/Prod |
| OPERATIONS           | NOT_READY      | Health deps; provenance; migrate CLI; runbooks (this pack)                | Real staging topology                              | Owner (D-001/D-005)     | Approve staging environment                                    | Staging      |
| REPORTING            | NOT_READY      | Sensitive aggregate reporting disabled                                    | D-025 policy                                       | Owner                   | Decide D-025                                                   | Production   |

No gate is marked `READY`.
