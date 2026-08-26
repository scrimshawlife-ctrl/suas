# SPEC-018 change map

## Gates (current honest posture)

| Gate                 | Verdict        | Blocker class                  | Notes                                                        |
| -------------------- | -------------- | ------------------------------ | ------------------------------------------------------------ |
| AUTH                 | NOT_READY      | EVIDENCE_FIXABLE               | Auth HTTP exists; adversarial abuse/rate evidence incomplete |
| CONSENT              | NOT_READY      | CODE_FIXABLE + EVIDENCE        | Domain present; JSON projection incomplete                   |
| CHECK-IN             | NOT_READY      | EVIDENCE_FIXABLE               | HTTP + scoring path live; staging evidence missing           |
| COORDINATION         | NOT_READY      | CODE_FIXABLE + OWNER           | Cases/claim live; durable async pending D-022                |
| EXTERNAL_FULFILLMENT | NOT_READY      | OWNER + INTENTIONAL            | Ports/fakes; real effects prohibited                         |
| UI_CONFORMANCE       | NOT_READY      | EVIDENCE_FIXABLE               | HTML reference surfaces exist                                |
| SAFETY               | NOT_READY      | EVIDENCE_FIXABLE               | D-012 slot JSON + HTML; no dispatch                          |
| PRIVACY              | NOT_READY      | EVIDENCE_FIXABLE               | Min-necessary projections; audit pack pending                |
| SCALE                | NOT_COMPUTABLE | OWNER_DECISION_REQUIRED        | D-021/D-023 targets unset                                    |
| RESILIENCE           | NOT_READY      | OWNER (D-022/D-024) + EVIDENCE | Fail-closed seams exist                                      |
| OPERATIONS           | NOT_READY      | OWNER + EVIDENCE               | Health enriched; runbooks pending                            |
| REPORTING            | NOT_READY      | OWNER (D-025)                  | Sensitive aggregate reporting disabled                       |

## Open D-0xx affecting pilot/production

| ID                    | Class                   | Packet                                        |
| --------------------- | ----------------------- | --------------------------------------------- |
| D-022                 | OWNER_DECISION_REQUIRED | `docs/decision-packets/D-022-durable-jobs.md` |
| D-021 / D-023 / D-024 | OWNER_DECISION_REQUIRED | pending packets                               |
| D-001 / D-005         | OWNER_DECISION_REQUIRED | staging/production hosting                    |

## HTTP vs domain gaps (remaining)

See `docs/openapi/v0.json` for implemented routes. Still missing vs APIS.md Plane A drafts: follow-ups, referrals, notifications, settlements, SR write commands.
