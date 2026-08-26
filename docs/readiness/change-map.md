# SPEC-018 change map

**Runtime head:** `428c20d` (#71) and later.  
**OpenAPI:** `docs/openapi/v0.json` — 38 `/api/v0` routes with CI drift check.

## Gates (current honest posture)

| Gate                 | Verdict        | Blocker class                     | Notes                                                                                      |
| -------------------- | -------------- | --------------------------------- | ------------------------------------------------------------------------------------------ |
| AUTH                 | NOT_READY      | EVIDENCE_FIXABLE                  | Auth HTTP + rate-limit adversarial tests exist; staging soak missing                       |
| CONSENT              | NOT_READY      | EVIDENCE_FIXABLE                  | List/grant/revoke + trusted-circle JSON shipped (#63/#70); staging soak / policy review    |
| CHECK-IN             | NOT_READY      | EVIDENCE_FIXABLE                  | HTTP + scoring path live; staging soak missing                                             |
| COORDINATION         | NOT_READY      | OWNER (D-022) + EVIDENCE          | Cases/claim, SR create/commands, follow-ups shipped (#58/#71); durable async pending D-022 |
| EXTERNAL_FULFILLMENT | NOT_READY      | OWNER + INTENTIONALLY_UNAVAILABLE | Ports/fakes; real effects prohibited                                                       |
| UI_CONFORMANCE       | NOT_READY      | EVIDENCE_FIXABLE                  | HTML reference surfaces exist; human a11y/visual baseline                                  |
| SAFETY               | NOT_READY      | EVIDENCE_FIXABLE                  | D-012 slot JSON + HTML; no dispatch; staging `approved` mode review                        |
| PRIVACY              | NOT_READY      | EVIDENCE_FIXABLE                  | Min-necessary projections + audit pack; deletion drill / staging evidence                  |
| SCALE                | NOT_COMPUTABLE | OWNER_DECISION_REQUIRED           | D-021/D-023 envelopes unset; synthetic measurements only                                   |
| RESILIENCE           | NOT_READY      | OWNER (D-022/D-024) + EVIDENCE    | Fail-closed seams + drills exist; durable queue + RTO/RPO pending                          |
| OPERATIONS           | NOT_READY      | OWNER (D-001/D-005) + EVIDENCE    | Health/runbooks/migrate harness exist; real staging topology pending                       |
| REPORTING            | NOT_READY      | OWNER (D-025)                     | Sensitive aggregate reporting disabled                                                     |

## Open D-0xx affecting pilot/production

| ID                    | Class                   | Packet                                               |
| --------------------- | ----------------------- | ---------------------------------------------------- |
| D-022                 | OWNER_DECISION_REQUIRED | `docs/decision-packets/D-022-durable-jobs.md`        |
| D-021 / D-023 / D-024 | OWNER_DECISION_REQUIRED | `docs/decision-packets/D-021-023-024-slo-rto.md`     |
| D-001 / D-005         | OWNER_DECISION_REQUIRED | `docs/decision-packets/D-001-005-staging-hosting.md` |
| D-025                 | OWNER_DECISION_REQUIRED | (reporting policy; packet not required for this cut) |

## HTTP vs domain gaps (remaining)

Released sync Plane A writes for Check-In, cases/claim, resources, immediate-resources, veterans/me, consents, trusted-circle, SR create/commands, follow-ups, and notifications inbox/preferences are implemented.

Still **not** CODE_FIXABLE product gaps for this residual set:

- Durable job vendor (D-022) — OWNER
- Staging hosting (D-001/D-005) — OWNER / EXTERNAL
- SLO/RTO/RPO envelopes (D-021/D-023/D-024) — OWNER → SCALE `NOT_COMPUTABLE`
- Referrals / settlements admin MFA surfaces beyond current release — only if still released; otherwise leave as future
- Real provider effects — INTENTIONALLY_UNAVAILABLE
- Mobile clients — INTENTIONALLY_UNAVAILABLE this sprint
