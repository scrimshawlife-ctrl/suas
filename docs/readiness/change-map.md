# SPEC-018 change map

**Runtime head:** PR `#111` plus verification hardening through `d73bc1c`.
**OpenAPI:** `docs/openapi/v0.json` — `/api/v0` routes with CI drift check; settle:check asserts every `CASE_COMMANDS` verb.

## Gates (current honest posture)

| Gate                 | Verdict        | Blocker class                     | Notes                                                                                                          |
| -------------------- | -------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| AUTH                 | NOT_READY      | EVIDENCE + OWNER                  | Auth HTTP + adversarial tests + STAGING soak; abuse-SLO constants remain inferred                              |
| CONSENT              | NOT_READY      | EVIDENCE_FIXABLE                  | List/grant/revoke + trusted-circle JSON + STAGING soak; human policy review remains                            |
| CHECK-IN             | NOT_READY      | EVIDENCE_FIXABLE                  | HTTP + scoring path + STAGING soak; gate settlement remains                                                    |
| COORDINATION         | NOT_READY      | EVIDENCE_FIXABLE                  | Full case/SR/follow-up HTTP; D-022 outbox live; STAGING soak green                                             |
| EXTERNAL_FULFILLMENT | NOT_READY      | OWNER + INTENTIONALLY_UNAVAILABLE | Ports/fakes; real effects prohibited                                                                           |
| UI_CONFORMANCE       | NOT_READY      | EVIDENCE_FIXABLE                  | LOCAL pinned UI/a11y pack landed (`evidence/local-ui-a11y-2026-08-26/`); human review + STAGING re-run remain  |
| SAFETY               | NOT_READY      | EVIDENCE_FIXABLE                  | D-012 slot JSON + HTML; no dispatch; staging `approved` mode review                                            |
| PRIVACY              | NOT_READY      | EVIDENCE_FIXABLE                  | Min-necessary projections + audit pack; D-007 DECIDED; STAGING rehearsal evidence landed; purge/export remains |
| SCALE                | NOT_COMPUTABLE | OWNER_DECISION_REQUIRED           | D-021/D-023 envelopes unset; synthetic measurements only                                                       |
| RESILIENCE           | NOT_READY      | EVIDENCE + OWNER (D-024)          | D-022 outbox live on STAGING; D-024 RTO/RPO + restore rehearsal pending                                        |
| OPERATIONS           | NOT_READY      | EVIDENCE                          | Health/runbooks/formal STAGING/85-of-85 soak exist; PRODUCTION remains closed                                  |
| REPORTING            | NOT_READY      | OWNER (D-025)                     | Sensitive aggregate reporting disabled                                                                         |

## Open D-0xx affecting pilot/production

| ID                    | Class                   | Packet                                               |
| --------------------- | ----------------------- | ---------------------------------------------------- |
| D-022                 | DECIDED FOR STAGING     | `docs/decision-packets/D-022-durable-jobs.md`        |
| D-021 / D-023 / D-024 | OWNER_DECISION_REQUIRED | `docs/decision-packets/D-021-023-024-slo-rto.md`     |
| D-001 / D-005         | DECIDED FOR STAGING     | `docs/decision-packets/D-001-005-staging-hosting.md` |
| D-025                 | OWNER_DECISION_REQUIRED | (reporting policy; packet not required for this cut) |
| D-007                 | DECIDED FOR STAGING     | 365-day retained history; production purge deferred  |

## HTTP vs domain gaps (remaining)

Released sync Plane A writes for Check-In, every `CASE_COMMANDS` verb (claim/assign/triage/activate/move-to-followup/resume-active/escalate/resolve/close/reopen), settlements reads, resources, immediate-resources, veterans/me, consents, trusted-circle invite/accept/remove, contact-log, SR create/commands, follow-ups, and notifications inbox/preferences are implemented.

No remaining CODE_FIXABLE Plane A JSON gaps for this residual set (case-command enum coverage + Settlement reads shipped; settle:check enforces the enum).

Still **not** CODE_FIXABLE product gaps for this residual set:

- SLO/RTO/RPO envelopes (D-021/D-023/D-024) — OWNER → SCALE `NOT_COMPUTABLE`
- Production retention purge/export (D-007) — separate owner authorization
- Sensitive aggregate reporting (D-025) — OWNER
- Referrals / settlements admin MFA surfaces beyond current release — only if still released; otherwise leave as future
- Real provider effects — INTENTIONALLY_UNAVAILABLE
- Mobile clients — INTENTIONALLY_UNAVAILABLE this sprint
