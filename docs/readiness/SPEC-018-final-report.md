# SPEC-018 production-readiness report

> **Post-report update (2026-08-29):** D-022 is decided and implemented as a
> Postgres outbox, formal synthetic STAGING is live, the pinned soak is 85/85,
> the D-007 STAGING deletion rehearsal passed, and PR #119 adds approved pilot
> challenge limits, pilot recovery objectives, D-007 export-package primitives,
> and a green remote verification path. This report retains the original
> settlement outcome. The added work is not a production authorization and does
> not convert any gate to `READY`.

## OUTCOME

`SPEC_018_BLOCKED_WITH_MINIMAL_RESIDUAL_SET`

## OBSERVED

- Spec stack `0.2.0`; formal readiness remains `NOT_READY` for pilot/production.
- Runtime main advanced through PR `#111`, including case-command HTTP coverage for every `CASE_COMMANDS` verb (claim/assign/triage/activate/move-to-followup/resume-active/escalate/resolve/close/reopen), Settlement reads, the D-022 Postgres outbox, formal synthetic STAGING, and D-007 deletion evidence.
- OpenAPI documents all released case commands; `settle:check` derives required routes from `CASE_COMMANDS` (empty intentional-defer allowlist).
- All 12 gates: none `READY`; SCALE remains `NOT_COMPUTABLE` because approved pilot objectives are not yet measured; others are `NOT_READY` with named owner/evidence blockers (`gate-matrix.md`). Shared STAGING and durable-job evidence are no longer blockers.
- No remaining CODE_FIXABLE Plane A JSON gaps for released case commands + Settlement. The residual set is evidence, operations, and owner authorization, with deliberately bounded pilot-only implementation work.

## COMPLETED (this sprint)

- Scoring: exact `qv-001`; `disabled` refuses `computeSignal`, `computeSv001`, and `SV_001_ENGINE.compute`; golden vectors unchanged.
- JSON `/api/v0`: auth, check-ins, cases/claim/assign/resolve, settlements reads, resources, immediate-resources, veterans/me, consents list/grant/revoke, trusted-circle invite/accept/remove, contact-log, SR create/commands, follow-ups, notifications inbox/preferences, admin adapters; OpenAPI + CI drift.
- Job port conformance suite; health dependency posture; D-022 / D-021–024 / D-001–005 decision packets.
- Security/privacy audit + adversarial HTTP tests; npm audit residual documented (dev toolchain only).
- Runbooks (deploy/rollback, incident); env matrix; synthetic load + migration apply rehearsal + synthetic deletion drill scripts.
- Gate matrix + change map + consistency audit + this report.
- Post-report: D-022 Postgres-outbox adapter and worker; formal synthetic Worker + Neon STAGING; 85/85 route soak; STAGING deletion rehearsal retaining events for 365 days; approved pilot D-021/D-023/D-024 objectives; approved pilot auth limits; D-007 encrypted export-package primitive with no delivery effect; synthetic STAGING schema version 13; public smoke 4/4; PR #119 remote verify green.

## READINESS MATRIX

See `docs/readiness/gate-matrix.md`.

## RESIDUAL BLOCKERS (launch-impact order)

1. **Human UI/a11y review + STAGING rerun** — EVIDENCE — automated local baseline is pinned; contrast/focus/reflow still needs human review.
2. **Approved safety-copy operations review** — EVIDENCE — exercise STAGING in `approved` mode without enabling automated dispatch.
3. **D-007 retention completion** — ENGINEERING / OWNER — STAGING soft-delete rehearsal and a pilot export-package primitive exist, but delivery and an authorized 365-day destructive purge path remain absent.
4. **Measured SLO and restore evidence** — ENGINEERING / OPERATIONS — pilot D-021/D-023/D-024 objectives are approved, but SCALE lacks sustained-load measurements and RESILIENCE lacks a backup-based restore measurement.
5. **D-025 reporting policy** — OWNER — sensitive aggregate reporting stays disabled.
6. **Vitest/esbuild GHSA** — tooling only (runtime dependencies remain clean).

## OWNER DECISIONS

- D-022 is decided and implemented — `docs/decision-packets/D-022-durable-jobs.md`
- D-001/D-005 formal synthetic STAGING is established — `docs/decision-packets/D-001-005-staging-hosting.md`
- D-021/D-023/D-024 pilot objectives — `docs/decision-packets/D-021-023-024-slo-rto.md`
- D-025 reporting policy remains owner-blocked — see `gate-matrix.md`

## VERIFICATION

- Full verify on HEAD (format/lint/typecheck/build/full suite/openapi/migrate) — see sprint `full-verify.log`
- Targeted suites including `http-api-writes`, scoring bypass, consents, OpenAPI drift
- `npm run openapi:check` — registered routes match OpenAPI
- Scripts: `scripts/synthetic-load-harness.ts`, `scripts/migration-restore-rehearsal.ts`, `scripts/deletion-drill.ts`
- Existing: `tests/integration/resilience-drills.test.ts`
- CI: PR `#79` verify green; main push verify `https://github.com/scrimshawlife-ctrl/suas/actions/runs/32931373216` (`headSha=e8d3082`); pages `32931373200`; recorded in sprint `ci-run.txt`
- PR #119: remote `verify` passed, including migration harness and provenance
- Local: 1,039 tests / 73 files; OpenAPI drift checks and `settle:check` passed
- Post-report STAGING: health `ok`, database configured, durable `postgres-outbox`; 17 routes × 5 attempts = 85/85; `jobs:work --once` exited 0.
- Post-report privacy: D-007 STAGING rehearsal `ok`; operational rows soft-deleted, sessions revoked, event history retained; an encrypted pilot export package can be constructed but is not delivered; automatic purge remains unimplemented.

## NEXT GOAL

Complete the human UI/a11y and approved safety-copy STAGING reviews, measure the approved pilot SLO objectives, execute a backup-based restore rehearsal, and implement only an authorized D-007 operational delivery or purge path. Then re-settle the gates. Keep PRODUCTION, mobile, sensitive reporting, and real-provider effects closed until their residual blockers are released.
