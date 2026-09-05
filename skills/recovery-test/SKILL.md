---
name: recovery-test
description: Check recovery evidence using approved synthetic fixtures.
version: 1.0.0
kind: runtime
status: active
authority: released-runtime-conformance
inputs:
  [recovery_contract, environment, backup_identity, runtime_provenance, durability_expectations]
outputs: [recovery_execution]
fail_closed: true
self_test: skills/self-tests/recovery-test.yaml
---

# recovery-test

## Purpose

Execute and record approved SUAS backup/restore and durable-work recovery exercises.

## Trigger

Use when a readiness/evidence gate requires restoration proof, when validating backup integrity, or when determining whether migration rehearsal is insufficient.

## Inputs

- Governing recovery/readiness contract from `SUAS-specs`.
- Approved target environment.
- Backup/restore mechanism and backup identity.
- Current app/schema/config identities and durable-job expectations.

## Procedure

1. Read `CONTEXT.md`, `AGENTS.md`, environment constraints, and governing recovery contract.
2. Confirm the target is approved; do not use production without explicit authority.
3. Capture pre-exercise runtime/schema/config provenance and backup identity.
4. Perform the actual restore exercise; do not substitute migration rehearsal.
5. Record UTC start/end and restoration duration.
6. Validate schema/version, required records, integrity constraints, and explicit loss boundary.
7. Validate durable queued work, replay handling, and idempotency after restore where applicable.
8. Record failures, duplicate effects, data loss, and unresolved ambiguity.
9. Do not infer production RTO/RPO/SLO guarantees unless released authority permits the claim.

## Invocation example

`Execute the approved STAGING restore exercise for the current commit and record integrity, loss boundary, durable-job behavior, and idempotency evidence.`

## Output schema

```yaml
exercise_id: string
environment: string
runtime_commit: string
backup_id: string
restore_target: string
started_at_utc: string
ended_at_utc: string
duration_seconds: number
schema_version: string
integrity_result: PASS|FAIL|PARTIAL
loss_boundary: string|NOT_COMPUTABLE
durable_job_result: PASS|FAIL|NOT_APPLICABLE|NOT_COMPUTABLE
idempotency_result: PASS|FAIL|NOT_APPLICABLE|NOT_COMPUTABLE
evidence: [string]
findings: [string]
claims_not_authorized: [string]
```

## Self-test

Run `skills/self-tests/recovery-test.yaml`. Migration-only evidence must return NOT_COMPUTABLE for a gate that requires an actual restore exercise.

## Completion criteria

Complete only when restore integrity, loss boundary, and durable-work behavior are explicitly evidenced or marked NOT_COMPUTABLE with missing prerequisites identified.
