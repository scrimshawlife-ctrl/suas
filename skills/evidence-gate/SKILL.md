---
name: evidence-gate
version: 1.0.0
kind: runtime
status: active
authority: released-runtime-conformance
inputs: [gate_id, spec_authority, runtime_provenance, evidence_artifacts, owner_disposition]
outputs: [gate_assessment]
fail_closed: true
self_test: skills/self-tests/evidence-gate.yaml
---

# evidence-gate

## Purpose
Assess runtime evidence against canonical SUAS gate requirements and prevent implementation state from being mistaken for readiness or authority.

## Trigger
Use before any readiness, pilot, production, reporting, or feature-enablement claim and whenever evidence may be stale after runtime changes.

## Inputs
- Governing gate/decision from `SUAS-specs`.
- Current app commit/version, schema/migration version, configuration, environment, fixture identities, and evidence artifacts.
- Owner disposition when required.

## Procedure
1. Read `CONTEXT.md`, `AGENTS.md`, active manifest, and governing spec gate.
2. Resolve current runtime provenance.
3. Inventory required evidence and map each artifact to the exact runtime identity it tested.
4. Re-run or invalidate evidence when code, schema, config, fixture, dependency, or environment identity changed materially.
5. Classify evidence as PRESENT_VALID, PRESENT_STALE, PRESENT_CONTRADICTORY, or MISSING.
6. Compute only the gate state permitted by the governing spec.
7. Preserve disabled/blocked behavior until explicit released authority permits activation.

## Invocation example
`Assess whether D-025 can move from blocked using the current runtime commit, schema, STAGING evidence, and owner disposition.`

## Output schema
```yaml
gate_id: string
runtime_commit: string
schema_version: string|null
environment: string
status: IMPLEMENTED|VERIFIED|ACCEPTED|RELEASED|NOT_READY|NOT_COMPUTABLE|DECISION_PENDING
evidence:
  - id: string
    state: PRESENT_VALID|PRESENT_STALE|PRESENT_CONTRADICTORY|MISSING
    reference: string|null
    hash: string|null
owner_disposition: ACCEPT|REJECT|DEFER|null
missing: [string]
stale_due_to: [string]
next_minimum_action: [string]
```

## Self-test
Run `skills/self-tests/evidence-gate.yaml`. A fixture with valid evidence from an older runtime commit must classify that evidence as stale and must not return ACCEPTED or RELEASED.

## Completion criteria
Complete only when every required artifact is tied to current runtime provenance and no readiness/authority claim exceeds released spec authority.