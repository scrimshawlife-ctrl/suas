# SPEC-018 production-readiness report

## OUTCOME

`SPEC_018_BLOCKED_WITH_MINIMAL_RESIDUAL_SET`

## OBSERVED

- Spec stack `0.2.0`; formal readiness remains `NOT_READY` for pilot/production.
- Runtime main advanced through PRs `#59`–`#63` (scoring fail-closed; resources + OpenAPI; veterans/me; job conformance + D-022 packet; consents + security audit).
- CI verify green on those PRs (see `ci-run` evidence in sprint scratch / Actions).
- All 12 gates: none `READY`; SCALE `NOT_COMPUTABLE`; others `NOT_READY` with named blockers (gate-matrix.md).

## COMPLETED (this sprint)

- Scoring: exact `qv-001`; disabled mode refuses `computeSignal`; golden vectors unchanged.
- JSON `/api/v0`: resources, immediate-resources, veterans/me, consents grant/revoke, SR create/commands, follow-ups, notifications inbox/preferences, trusted-circle; OpenAPI + CI drift.
- Scoring: disabled mode also refuses `computeSv001` / `SV_001_ENGINE.compute` / registered engine.compute.
- Job port conformance suite; health dependency posture; D-022 / D-021–024 / D-001–005 decision packets.
- Security/privacy audit + adversarial HTTP tests; npm audit residual documented (dev toolchain only).
- Runbooks (deploy/rollback, incident); env matrix; synthetic load + migration apply rehearsal scripts.
- Gate matrix + consistency audit + this report.

## READINESS MATRIX

See `docs/readiness/gate-matrix.md`.

## RESIDUAL BLOCKERS (launch-impact order)

1. **D-022 durable job product** — blocks honest STAGING/PRODUCTION async.
2. **D-001 / D-005 staging hosting** — blocks shared staging evidence.
3. **D-021 / D-023 / D-024 SLO/RTO/RPO** — SCALE stays `NOT_COMPUTABLE`.
4. Remaining CODE_FIXABLE Plane A JSON essentially closed for released sync writes; residual is staging soak + owner decisions.
5. Human UI conformance / a11y baseline — EVIDENCE.
6. Vitest/esbuild GHSA (dev-only) — tooling upgrade.

## OWNER DECISIONS

- D-022 (recommended: Postgres outbox first) — `docs/decision-packets/D-022-durable-jobs.md`
- D-001/D-005 staging hosting — `docs/decision-packets/D-001-005-staging-hosting.md`
- D-021/D-023/D-024 envelopes — `docs/decision-packets/D-021-023-024-slo-rto.md`

## VERIFICATION

- Targeted vitest suites for scoring, HTTP resources/veterans/consents/security, OpenAPI drift, jobs.
- `npm run openapi:check`
- Scripts: `scripts/synthetic-load-harness.ts`, `scripts/migration-restore-rehearsal.ts`
- Existing: `tests/integration/resilience-drills.test.ts`
- CI: PRs `#59`–`#63` verify jobs green

## NEXT GOAL

Owner decides D-022 + staging hosting; eng implements durable adapter behind the existing port and finishes remaining released Plane A JSON; re-run gate settlement.
