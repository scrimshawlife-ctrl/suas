# SKILLS.md — SUAS runtime agent skills

This file defines the reusable agent skills recommended for implementation work in `SUAS`.

`SUAS` is the implementation/conformance repository. Runtime skills MUST conform to released authority from `SUAS-specs` and MUST follow `AGENTS.md`, `CONTEXT.md`, the active release manifest, environment rules, and applicable readiness/evidence contracts.

## Required core skills

| Skill | Purpose in SUAS runtime | Requirement |
|---|---|---|
| `github` | Inspect branches, commits, PRs, review threads, Actions, releases, evidence references, and cross-repo changes. | REQUIRED |
| `implementation` | Implement only released SUAS contracts and preserve existing invariants. | REQUIRED |
| `code-review` | Detect contract drift, regressions, unsafe defaults, authority leaks, and non-minimal changes. | REQUIRED |
| `test-engineering` | Execute and extend unit, integration, E2E, regression, golden-vector, and negative-path tests. | REQUIRED |
| `security-audit` | Validate authentication, authorization, tenant isolation, secrets, provider boundaries, replay safety, and fail-closed behavior. | REQUIRED |
| `browser-testing` | Exercise real public and authenticated SUAS routes in LOCAL/STAGING using authorized synthetic/operator-scoped credentials. | REQUIRED |
| `api-integration` | Implement released provider adapters behind SUAS-owned capability ports and preserve sandbox/production boundaries. | REQUIRED |
| `database-migration-audit` | Validate schema changes, forward/rollback behavior, data lifecycle, tenant isolation, and compatibility. | REQUIRED |
| `deployment-runbook` | Validate build provenance, environment configuration, staging soak evidence, rollback, and release gates. | REQUIRED |
| `documentation` | Keep runtime handoffs, operational notes, evidence references, and implementation records current. | REQUIRED |

## Platform skills

Use these when the active implementation slice requires them:

- `supabase` — database, migrations, RLS/RPC/auth/storage where the released architecture uses Supabase.
- `vercel` — deployment, environment configuration, build inspection, logs, and staging/production validation where applicable.
- `frontend-design` — implement released UI behavior without inventing domain semantics or hiding degraded/unavailable states.
- `observability` — structured logs, traces, audit events, redaction, and runtime diagnostics.
- `accessibility-audit` — automated accessibility checks plus preparation and capture of required human-review evidence.

## SUAS-specialized runtime skills

### `contract-validation`

Purpose: prove runtime behavior matches released deterministic contracts.

Required behavior:

- Resolve exact released spec, questionnaire, scoring, manifest, and schema identities before verification.
- Run golden vectors and boundary cases.
- Verify provenance/basis fields correspond exactly to accepted inputs and effective contract identities.
- Verify missing-input behavior matches the released conservative rule.
- Verify safety escalation behavior and downstream effects exactly.
- Verify disabled/unavailable modes cannot invoke functionality when the contract requires non-callability.
- Return semantic ambiguity to `SUAS-specs`; do not patch around an unresolved product decision.

### `evidence-gate`

Purpose: prevent implementation state from being confused with readiness or authority.

Required behavior:

- Track `IMPLEMENTED`, `VERIFIED`, `ACCEPTED`, `RELEASED`, `NOT_READY`, `NOT_COMPUTABLE`, and pending states separately.
- Never enable blocked behavior because code exists or CI is green.
- Collect exact evidence references, hashes, build provenance, environment, UTC timestamps/cutoffs, scope, constraints, and owner disposition required by the governing gate.
- Preserve disabled states until explicit re-settlement or released authority allows activation.
- Detect stale evidence after code, schema, configuration, fixture, or dependency changes.

### `synthetic-data`

Purpose: generate and use reproducible privacy-safe runtime fixtures.

Required behavior:

- Never substitute real veteran/production data for synthetic fixtures in prohibited environments.
- Produce deterministic IDs, values, mappings, expected outputs, and dataset hashes when evidence depends on exact data.
- Include positive, negative, boundary, empty/NO_HIT, malformed, replay, duplicate, and cross-tenant cases as applicable.
- Keep synthetic fixtures executable against actual adapters/contracts rather than documentation-only examples.
- Preserve deletion/export/retention states and other policy-sensitive fixture attributes needed for tests.

### `recovery-test`

Purpose: execute and record approved backup/restore and durable-work recovery exercises.

Required behavior:

- Use an approved non-production or explicitly authorized target.
- Record backup identity, restored schema/build identity, UTC timing, restoration duration, integrity/schema validation, loss boundary, durable-job behavior, and result.
- Exercise replay/idempotency behavior after restoration where applicable.
- Distinguish a migration rehearsal from a real backup/restore exercise.
- Do not infer production RTO/RPO/SLO guarantees from incomplete evidence.

### `adversarial-testing`

Purpose: exercise boundaries that must fail closed.

Required behavior:

- Test unauthenticated, unauthorized, wrong-role, wrong-tenant, stale/revoked credential, malformed input, replay, duplicate delivery, unavailable provider, disabled feature, timeout, and ambiguous provider outcome cases as applicable.
- Include cross-tenant negatives across API, database, async jobs, caches, adapters, reports, and admin surfaces where present.
- Verify rejected operations do not cause external or persistent business effects.
- Confirm retries are idempotent and ambiguous mutation outcomes reconcile before risky retry.

### `accessibility-audit`

Purpose: validate released SUAS UI accessibility and generate reviewable evidence.

Required behavior:

- Run automated checks against the actual built surface.
- Validate keyboard/focus behavior, labels/names, semantic structure, contrast, zoom/reflow, reduced motion where applicable, error communication, and safety-copy presentation.
- Capture route, build provenance, environment, viewport/device, tool/version, evidence artifact, and findings.
- Do not mark a human-review gate complete from automation alone.

## Runtime execution order

For a normal implementation slice, prefer this sequence:

1. Read `CONTEXT.md` and `AGENTS.md`.
2. Resolve the released spec section, release manifest, environment contract, and acceptance/readiness contract.
3. Use `implementation` for the smallest contract-faithful change.
4. Use `test-engineering` and `contract-validation` to verify deterministic behavior.
5. Use `security-audit` and `adversarial-testing` for boundary-sensitive changes.
6. Use `database-migration-audit` for schema/data changes.
7. Use `browser-testing` and `accessibility-audit` for client-route changes.
8. Use `recovery-test` when the gate requires restore evidence.
9. Use `evidence-gate` before any readiness, pilot, production, reporting, or feature-enablement claim.
10. Record evidence/provenance and return any semantic gap to `SUAS-specs`.

## Recommended team bundle

For coding agents working in this repository, install or provide equivalents for:

`github`, `implementation`, `code-review`, `test-engineering`, `security-audit`, `browser-testing`, `api-integration`, `database-migration-audit`, `deployment-runbook`, `documentation`, `supabase`, `vercel`, `frontend-design`, `observability`, `contract-validation`, `evidence-gate`, `synthetic-data`, `recovery-test`, `adversarial-testing`, and `accessibility-audit`.

The specialized skills are project-local behavioral contracts. If an agent platform does not provide them natively, implement them as reusable deterministic skills rather than relying on prompt memory.
