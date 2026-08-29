---
name: contract-validation
version: 1.0.0
kind: runtime
status: active
authority: released-runtime-conformance
inputs: [release_manifest, contract_identities, runtime_provenance, golden_vectors, test_commands]
outputs: [contract_verdict]
fail_closed: true
self_test: skills/self-tests/contract-validation.yaml
---

# contract-validation

## Purpose

Prove that SUAS runtime behavior conforms to exact released deterministic contracts.

## Trigger

Use for scoring/questionnaire changes, version-pin changes, provenance/basis fields, missing-input behavior, safety escalation, disabled modes, and contract-sensitive regressions.

## Inputs

- Released spec/manifest and exact contract identities.
- Current runtime commit/build/schema identities.
- Golden vectors, boundary cases, and relevant test commands.

## Procedure

1. Read `CONTEXT.md`, `AGENTS.md`, active manifest, and referenced contract sections.
2. Pin exact contract and runtime identities.
3. Run focused tests for required/optional inputs, conservative missing-input behavior, mappings, escalation, and downstream effects.
4. Run golden vectors and boundary cases.
5. Compare emitted provenance/basis fields to accepted inputs and active identities.
6. Verify disabled/unavailable modes are non-callable when required, not merely hidden from UI.
7. Record each invariant as PASS, FAIL, or NOT_COMPUTABLE with evidence.
8. Return semantic ambiguity to `SUAS-specs` rather than inventing runtime behavior.

## Invocation example

`Validate qv-001/sv-001 on the current runtime commit, including golden vectors, missing-input behavior, basis provenance, and disabled-mode non-callability.`

## Output schema

```yaml
contract_id: string
spec_version: string
manifest: string
runtime_commit: string
schema_version: string|null
checks:
  - invariant: string
    result: PASS|FAIL|NOT_COMPUTABLE
    evidence: string|null
mismatches: [string]
verdict: CONFORMANT|NON_CONFORMANT|NOT_COMPUTABLE
minimum_fix_or_spec_decision: [string]
```

## Self-test

Run `skills/self-tests/contract-validation.yaml`. The fixture must classify a basis/version mismatch as NON_CONFORMANT and must not repair unresolved semantics locally.

## Completion criteria

Complete only when all applicable invariants are classified against current runtime provenance and the verdict is reproducible.
