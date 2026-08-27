# SPEC-018 change map

**Runtime head:** post-`#80` + full `CASE_COMMANDS` HTTP.  
**OpenAPI:** `docs/openapi/v0.json` — `/api/v0` routes with CI drift check; settle:check asserts every `CASE_COMMANDS` verb.

## Gates (current honest posture)

| Gate                 | Verdict        | Blocker class                     | Notes                                                                                                         |
| -------------------- | -------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| AUTH                 | NOT_READY      | EVIDENCE_FIXABLE                  | Auth HTTP + rate-limit adversarial tests exist; staging soak missing                                          |
| CONSENT              | NOT_READY      | EVIDENCE_FIXABLE                  | List/grant/revoke + trusted-circle JSON shipped (#63/#70); staging soak / policy review                       |
| CHECK-IN             | NOT_READY      | EVIDENCE_FIXABLE                  | HTTP + scoring path live; staging soak missing                                                                |
| COORDINATION         | NOT_READY      | OWNER (D-022) + EVIDENCE          | Cases/claim, SR create/commands, follow-ups shipped (#58/#71); durable async pending D-022                    |
| EXTERNAL_FULFILLMENT | NOT_READY      | OWNER + INTENTIONALLY_UNAVAILABLE | Ports/fakes; real effects prohibited                                                                          |
| UI_CONFORMANCE       | NOT_READY      | EVIDENCE_FIXABLE                  | LOCAL pinned UI/a11y pack landed (`evidence/local-ui-a11y-2026-08-26/`); human review + STAGING re-run remain |
| SAFETY               | NOT_READY      | EVIDENCE_FIXABLE                  | D-012 slot JSON + HTML; no dispatch; staging `approved` mode review                                           |
| PRIVACY              | NOT_READY      | EVIDENCE_FIXABLE + OWNER (D-007)  | Min-necessary projections + audit pack; synthetic deletion drill shipped; D-007 + staging remain              |
| SCALE                | NOT_COMPUTABLE | OWNER_DECISION_REQUIRED           | D-021/D-023 envelopes unset; synthetic measurements only                                                      |
| RESILIENCE           | NOT_READY      | EVIDENCE + OWNER (D-024)          | D-022 DECIDED + postgres-outbox adapter; STAGING wire + D-024 RTO/RPO pending                                 |
| OPERATIONS           | NOT_READY      | EVIDENCE + EVIDENCE               | Health/runbooks/migrate harness exist; real staging topology pending                                          |
| REPORTING            | NOT_READY      | OWNER (D-025)                     | Sensitive aggregate reporting disabled                                                                        |

## Open D-0xx affecting pilot/production

| ID                    | Class                   | Packet                                               |
| --------------------- | ----------------------- | ---------------------------------------------------- |
| D-022                 | OWNER_DECISION_REQUIRED | `docs/decision-packets/D-022-durable-jobs.md`        |
| D-021 / D-023 / D-024 | OWNER_DECISION_REQUIRED | `docs/decision-packets/D-021-023-024-slo-rto.md`     |
| D-001 / D-005         | OWNER_DECISION_REQUIRED | `docs/decision-packets/D-001-005-staging-hosting.md` |
| D-025                 | OWNER_DECISION_REQUIRED | (reporting policy; packet not required for this cut) |
| D-007                 | OWNER_DECISION_REQUIRED | Retention/deletion durations; synthetic drill only   |

## HTTP vs domain gaps (remaining)

Released sync Plane A writes for Check-In, every `CASE_COMMANDS` verb (claim/assign/triage/activate/move-to-followup/resume-active/escalate/resolve/close/reopen), settlements reads, resources, immediate-resources, veterans/me, consents, trusted-circle invite/accept/remove, contact-log, SR create/commands, follow-ups, and notifications inbox/preferences are implemented.

No remaining CODE_FIXABLE Plane A JSON gaps for this residual set (case-command enum coverage + Settlement reads shipped; settle:check enforces the enum).

Still **not** CODE_FIXABLE product gaps for this residual set:

- Durable job vendor (D-022) — OWNER
- Staging hosting (D-001/D-005) — OWNER / EXTERNAL
- SLO/RTO/RPO envelopes (D-021/D-023/D-024) — OWNER → SCALE `NOT_COMPUTABLE`
- Referrals / settlements admin MFA surfaces beyond current release — only if still released; otherwise leave as future
- Real provider effects — INTENTIONALLY_UNAVAILABLE
- Mobile clients — INTENTIONALLY_UNAVAILABLE this sprint
