# SPEC-018 production-readiness report

## OUTCOME

`SPEC_018_BLOCKED_WITH_MINIMAL_RESIDUAL_SET`

## OBSERVED

- Spec stack `0.2.0`; formal readiness remains `NOT_READY` for pilot/production.
- Runtime main advanced through PRs `#59`–`#71` (scoring fail-closed; resources + OpenAPI; veterans/me; job conformance + D-022 packet; consents + security audit; scoring bypass close; consent grant/revoke; SR commands + follow-ups + notifications).
- Head at settlement: `428c20d` (#71) and docs refresh that follows.
- OpenAPI documents **38** `/api/v0` routes with CI drift check.
- All 12 gates: none `READY`; SCALE `NOT_COMPUTABLE`; others `NOT_READY` with named owner/evidence blockers (`gate-matrix.md`).

## COMPLETED (this sprint)

- Scoring: exact `qv-001`; `disabled` refuses `computeSignal`, `computeSv001`, and `SV_001_ENGINE.compute`; golden vectors unchanged.
- JSON `/api/v0`: auth, check-ins, cases/claim/assign, resources, immediate-resources, veterans/me, consents list/grant/revoke, trusted-circle invite/accept/remove, contact-log, SR create/commands, follow-ups, notifications inbox/preferences, admin adapters; OpenAPI + CI drift.
- Job port conformance suite; health dependency posture; D-022 / D-021–024 / D-001–005 decision packets.
- Security/privacy audit + adversarial HTTP tests; npm audit residual documented (dev toolchain only).
- Runbooks (deploy/rollback, incident); env matrix; synthetic load + migration apply rehearsal + synthetic deletion drill scripts.
- Gate matrix + change map + consistency audit + this report.

## READINESS MATRIX

See `docs/readiness/gate-matrix.md`.

## RESIDUAL BLOCKERS (launch-impact order)

1. **D-022 durable job product** — OWNER — blocks honest STAGING/PRODUCTION async.
2. **D-001 / D-005 staging hosting** — OWNER / EXTERNAL — blocks shared staging evidence.
3. **D-021 / D-023 / D-024 SLO/RTO/RPO** — OWNER — SCALE stays `NOT_COMPUTABLE`.
4. **`createSettlement` `/api/v0` write** — CODE_FIXABLE (domain exists; JSON not yet exposed).
5. **Staging soak + human UI/a11y baseline** — EVIDENCE (needs staging or human review).
6. **D-007 retention/deletion durations** — OWNER — synthetic deletion drill exists; formal purge/export package and staging rehearsal do not. PRIVACY stays `NOT_READY`.
7. **Vitest/esbuild GHSA** — tooling only (runtime deps clean).

## OWNER DECISIONS

- D-022 (recommended: Postgres outbox first) — `docs/decision-packets/D-022-durable-jobs.md`
- D-001/D-005 staging hosting — `docs/decision-packets/D-001-005-staging-hosting.md`
- D-021/D-023/D-024 envelopes — `docs/decision-packets/D-021-023-024-slo-rto.md`

## VERIFICATION

- Full verify on HEAD (format/lint/typecheck/build/full suite/openapi/migrate) — see sprint `full-verify.log`
- Targeted suites including `http-api-writes`, scoring bypass, consents, OpenAPI drift
- `npm run openapi:check` — 38 routes
- Scripts: `scripts/synthetic-load-harness.ts`, `scripts/migration-restore-rehearsal.ts`, `scripts/deletion-drill.ts`
- Existing: `tests/integration/resilience-drills.test.ts`
- CI: PRs `#59`–`#71` verify green; main push CI recorded in `ci-run.txt`

## NEXT GOAL

Send the residual set, gate matrix, decision packets, and CI/OpenAPI evidence to adversarial verification for go/no-go confirmation **before** any owner D-022 / staging work. After owner decides D-022 + staging hosting, eng implements the durable adapter behind the existing port and runs staging soak, then re-settles gates.
