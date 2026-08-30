# Remaining engineering plan

**Date:** 2026-08-29
**Repository:** `scrimshawlife-ctrl/suas`
**Current review:** PR [#119](https://github.com/scrimshawlife-ctrl/suas/pull/119), `pilot-readiness-2026-08-29`
**Scope:** engineering implementation only. Owner decisions, human reviews, and production authorization remain explicit gates.

## Current repository and PR status

- PR #119 is open with the approved pilot-readiness stack; its required `verify` check passed on 2026-08-29.
- There are no open GitHub issues.
- Recent Pages PRs `#112` through `#118` are merged.
- The latest local full verification passed: 73 test files and 1,039 tests, with OpenAPI drift checks passing.
- The PR's remote `verify` run passed after the migration harness began creating its untracked `.env` placeholder from `.env.example` while retaining CI-provided variables as authoritative.
- Synthetic STAGING is deployed, schema version 13 is validated, public synthetic-STAGING smoke checks passed 4/4, and effects remain disabled.

## Readiness boundary

The current SPEC-018 evidence still says `NOT_READY` for pilot and production. The released Plane A JSON gaps are closed. The remaining work is a mixture of engineering, evidence, and owner authorization. This plan does not turn any of the following into implied readiness:

- real external effects
- production provider delivery
- production veteran data
- sensitive aggregate reporting
- legal or compliance certification

## Ordered implementation plan

### P0. Restore a green verification path — completed for the current review

1. A temporary `.env` is created from `.env.example` in the GitHub Actions verify job.
2. CI-provided environment variables remain authoritative, including the generated session secret and test database URLs.
3. PR #119's full verify workflow, including migration harness and provenance, passed.
4. The placeholder remains untracked and repository-hygiene checks passed.

**Exit condition met for PR #119:** the reviewed head has a green remote `verify` run. Merge remains a separate review decision.

### P1. Finish engineering that can move the pilot gates

#### 1. D-007 production retention package

**Current state:** approved pilot D-007 export-package primitives and retention planning are implemented and tested. The implementation does not deliver exports, create a download network effect, or perform destructive purges. Do not infer production retention semantics from the STAGING rehearsal.

When authorized, implement and test the package with these invariants:

- operational rows follow the approved deletion state transition
- sessions for the subject are revoked
- event, audit, and consent history are not silently deleted
- the approved 365-day retention rule is represented explicitly
- provider-side erasure remains outside the system claim unless separately authorized
- the operation is observable and produces evidence suitable for the privacy gate

Update the privacy runbook and add integration coverage against a representative database. Keep the existing synthetic deletion drill unchanged unless the approved production policy requires a separately named path.

#### 2. Resilience restore evidence

**Current state:** pilot D-021, D-023, and D-024 SLO, RTO, and RPO objectives are approved and encoded. A backup-based restore exercise is still required; the current migration rehearsal only proves applying migrations to an empty database.

Then:

1. encode only the approved thresholds and recovery assumptions
2. run `npm run migrate:rehearse` against the documented recovery setup
3. capture restore timing, data-loss boundary, schema validation, and durable-job behavior
4. update the resilience and operations evidence without marking a gate ready from synthetic measurements alone

The existing rehearsal script is an implementation starting point. It must not be represented as backup-restore proof or as an RTO/RPO measurement.

#### 3. Evidence reruns after code stabilizes

Engineering should regenerate the formal STAGING evidence after P0 and any P1 code change:

- authenticated route soak and job-worker evidence
- UI/a11y evidence at the supported widths
- D-012 approved safety-copy review without dispatch
- migration and health evidence

Human contrast, focus, reflow, policy, and safety-copy review remain human or operations work. Engineering owns the reproducible harness and evidence pack, not the approval decision.

#### 4. Auth constant release handling

The approved pilot challenge limits are now encoded. Remaining AUTH evidence is a staged abuse-SLO measurement, not an implied production policy. If values change:

- codify the decision in the appropriate release documentation
- update typed configuration and tests if the values change
- rerun adversarial rate-limit tests and STAGING evidence
- do not silently convert inferred values into an approved production policy

### P2. Implement released provider and policy decisions

#### 1. Resend email enablement

The Resend adapter is selected by D-004 / spec 0.6.0. To operate browser authentication in STAGING:

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

D-025 policy is recorded in `OPERATIONAL_AUTHORIZATION-2026-08-29.md`. The minimum fixed-dimension projection and k-threshold tests may be implemented, but sensitive aggregate reporting remains disabled. Release still requires access control, audit and retention evidence, Privacy and Safety review of rendered reports, and negative tests for unauthorized and cross-tenant access.

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

Completed 2026-08-29: Vitest was upgraded to 4.1.11, `npm audit` reports 0 vulnerabilities, and the full verification suite passes. Continue periodic dependency hygiene, but this remediation is not a substitute for the pilot or production gates.

## Dependency graph

```text
CI dotenv fix
  -> green current-HEAD verify
  -> refreshed STAGING evidence
  -> remaining owner decisions: safety, production retention, reporting
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
