# SPEC-018 production-readiness report

## OUTCOME

`SPEC_018_BLOCKED_WITH_MINIMAL_RESIDUAL_SET`

## OBSERVED

- Spec stack `0.2.0`; formal readiness remains `NOT_READY` for pilot/production.
- Runtime main advanced through PRs `#59`–`#79` (scoring fail-closed; resources + OpenAPI; veterans/me; job conformance + D-022 packet; consents + security audit; scoring bypass close; consent grant/revoke; SR commands + follow-ups + notifications; accept/contact-log/assign; case resolve + Settlement reads).
- Settlement HEAD: `e8d3082` (#79). OpenAPI **46** `/api/v0` operations; `npm run settle:check` OK on that HEAD.
- All 12 gates: none `READY`; SCALE `NOT_COMPUTABLE`; others `NOT_READY` with named owner/evidence blockers (`gate-matrix.md`).
- No remaining CODE_FIXABLE Plane A JSON gaps; residual set is owner/evidence/tooling only.

## COMPLETED (this sprint)

- Scoring: exact `qv-001`; `disabled` refuses `computeSignal`, `computeSv001`, and `SV_001_ENGINE.compute`; golden vectors unchanged.
- JSON `/api/v0`: auth, check-ins, cases/claim/assign/resolve, settlements reads, resources, immediate-resources, veterans/me, consents list/grant/revoke, trusted-circle invite/accept/remove, contact-log, SR create/commands, follow-ups, notifications inbox/preferences, admin adapters; OpenAPI + CI drift.
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
4. **Staging soak + human UI/a11y baseline** — EVIDENCE (needs staging or human review).
5. **D-007 retention/deletion durations** — OWNER — synthetic deletion drill exists; formal purge/export package and staging rehearsal do not. PRIVACY stays `NOT_READY`.
6. **Vitest/esbuild GHSA** — tooling only (runtime deps clean).

## OWNER DECISIONS

- D-022 (recommended: Postgres outbox first) — `docs/decision-packets/D-022-durable-jobs.md`
- D-001/D-005 staging hosting — `docs/decision-packets/D-001-005-staging-hosting.md`
- D-021/D-023/D-024 envelopes — `docs/decision-packets/D-021-023-024-slo-rto.md`

## VERIFICATION

- Full verify on HEAD (format/lint/typecheck/build/full suite/openapi/migrate) — see sprint `full-verify.log`
- Targeted suites including `http-api-writes`, scoring bypass, consents, OpenAPI drift
- `npm run openapi:check` — registered routes match OpenAPI
- Scripts: `scripts/synthetic-load-harness.ts`, `scripts/migration-restore-rehearsal.ts`, `scripts/deletion-drill.ts`
- Existing: `tests/integration/resilience-drills.test.ts`
- CI: PR `#79` verify green; main push verify `https://github.com/scrimshawlife-ctrl/suas/actions/runs/32931373216` (`headSha=e8d3082`); pages `32931373200`; recorded in sprint `ci-run.txt`
- Local: 875 tests / 57 files; `openapi drift check ok: 46`; `settle:check OK`

## NEXT GOAL

Owner decides D-022 (durable jobs) and D-001/D-005 (staging hosting). Eng then implements the durable adapter behind the existing port, runs staging soak + human UI/a11y baseline, then re-settles gates. Do not start mobile work until that residual set shrinks.
