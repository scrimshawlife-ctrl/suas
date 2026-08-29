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

## Completion criteria
Complete only when all applicable invariants are classified against current runtime provenance and the verdict is reproducible.