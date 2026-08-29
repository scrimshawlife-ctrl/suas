# Remaining engineering plan

**Date:** 2026-08-29
**Repository:** `scrimshawlife-ctrl/suas`
**Local HEAD:** `f457d43`
**Scope:** engineering implementation only. Owner decisions, human reviews, and production authorization remain explicit gates.

## Current repository and PR status

- There are no open pull requests.
- There are no open GitHub issues.
- Recent Pages PRs `#112` through `#118` are merged.
- The latest local full verification passed: 71 test files and 1,033 tests, with OpenAPI drift `53/53`.
- Two recent remote `verify` runs failed in the migration-harness step because `npm run migrate -- apply` loads `--env-file=.env` and the workflow did not create that temporary file. The workflow fix is tracked separately in `.github/workflows/verify.yml`.

## Readiness boundary

The current SPEC-018 evidence still says `NOT_READY` for pilot and production. The released Plane A JSON gaps are closed. The remaining work is a mixture of engineering, evidence, and owner authorization. This plan does not turn any of the following into implied readiness:

- real external effects
- production provider delivery
- production veteran data
- sensitive aggregate reporting
- legal or compliance certification

## Ordered implementation plan

### P0. Restore a green verification path

1. Create a temporary `.env` from `.env.example` in the GitHub Actions verify job.
2. Keep CI-provided environment variables authoritative, including the generated session secret and test database URLs.
3. Confirm the full verify workflow, including migration harness and provenance, passes on the current main lineage.
4. Confirm `.env` remains untracked and repository-hygiene checks stay green.

**Exit condition:** current HEAD has a green `verify` run, not only a local run.

### P1. Finish engineering that can move the pilot gates

#### 1. D-007 production retention package

**Dependency:** explicit owner authorization for the production purge/export behavior. Do not infer production retention semantics from the STAGING rehearsal.

When authorized, implement and test the package with these invariants:

- operational rows follow the approved deletion state transition
- sessions for the subject are revoked
- event, audit, and consent history are not silently deleted
- the approved 365-day retention rule is represented explicitly
- provider-side erasure remains outside the system claim unless separately authorized
- the operation is observable and produces evidence suitable for the privacy gate

Update the privacy runbook and add integration coverage against a representative database. Keep the existing synthetic deletion drill unchanged unless the approved production policy requires a separately named path.

#### 2. Resilience restore evidence

**Dependency:** owner-approved D-021, D-023, and D-024 SLO, RTO, and RPO envelopes.

Then:

1. encode only the approved thresholds and recovery assumptions
2. run `npm run migrate:rehearse` against the documented recovery setup
3. capture restore timing, data-loss boundary, schema validation, and durable-job behavior
4. update the resilience and operations evidence without marking a gate ready from synthetic measurements alone

The existing rehearsal script is an implementation starting point. The missing thresholds are an owner decision, not a code default.

#### 3. Evidence reruns after code stabilizes

Engineering should regenerate the formal STAGING evidence after P0 and any P1 code change:

- authenticated route soak and job-worker evidence
- UI/a11y evidence at the supported widths
- D-012 approved safety-copy review without dispatch
- migration and health evidence

Human contrast, focus, reflow, policy, and safety-copy review remain human or operations work. Engineering owns the reproducible harness and evidence pack, not the approval decision.

#### 4. Auth constant release handling

The AUTH gate still contains inferred abuse-limit constants. Once the owner either approves those constants or supplies released values:

- codify the decision in the appropriate release documentation
- update typed configuration and tests if the values change
- rerun adversarial rate-limit tests and STAGING evidence
- do not silently convert inferred values into an approved production policy

### P2. Implement released provider and policy decisions

#### 1. Resend email enablement

The Resend adapter already exists and is tested, but `SUAS_EMAIL_MODE=resend` is intentionally not a released configuration value. After the specification releases the mode and the sender identity is approved:

1. add the released mode to the typed configuration contract
2. select the existing Resend adapter from the channel registry
3. validate `RESEND_API_KEY` and `SUAS_EMAIL_FROM` at startup
4. keep provider references opaque and preserve timeout, idempotency, and log-redaction behavior
5. run a synthetic STAGING acceptance path before any production secret is used
6. document rollback to sink and the distinction between accepted and delivered

Until then, email stays on the declared sink path.

#### 2. Real fulfillment effects

Transportation, lodging, shelter, food, and peer-support effects remain intentionally unavailable until their corresponding provider decisions and production authorization are released. Do not wire live credentials or change adapter defaults as part of readiness cleanup.

#### 3. Sensitive reporting

D-025 must define the reporting policy before implementation. Until then, keep sensitive aggregate reporting disabled. After approval, implement the smallest authorized projection, authorization boundary, retention behavior, and audit evidence, then add negative tests for unauthorized and cross-tenant access.

### P3. Production operations after authorization

Only after SPEC-018 and the required owner decisions are released:

1. replace the safe Worker template with owner-controlled production deployment configuration
2. provision and verify Hyperdrive, secret storage, and environment bindings
3. apply migrations explicitly and validate the recorded schema version before traffic
4. run a production-like canary with real observability and rollback checks
5. verify health dependency behavior, durable job processing, alerting, runbooks, and rollback
6. record the deployment provenance and settle the readiness gates from evidence

Production must remain fail-closed while any required decision or evidence is absent.

### P4. Toolchain hygiene

The documented Vitest/Vite/esbuild advisory is dev-tooling-only. Upgrade it in a separate change after compatibility testing, then rerun the full suite and audit output. This is useful hygiene but is not a substitute for the pilot or production gates.

## Dependency graph

```text
CI dotenv fix
  -> green current-HEAD verify
  -> refreshed STAGING evidence
  -> owner decisions: auth, safety, retention, SLO/RTO/RPO, reporting
  -> authorized engineering implementations
  -> restore / deletion / provider acceptance evidence
  -> SPEC-018 gate resettlement
  -> production authorization and deployment
```

## Explicitly not planned in this cut

- mobile clients, which remain intentionally unavailable this sprint
- live external provider effects before released decisions
- legal or compliance certification
- any production data or credential use in local, test, or synthetic STAGING paths
