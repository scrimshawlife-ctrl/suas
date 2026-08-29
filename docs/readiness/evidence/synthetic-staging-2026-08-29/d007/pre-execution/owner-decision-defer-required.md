# D-007 synthetic dry-run authorization · DEFER_REQUIRED

This is **not** an approval. I cannot designate myself as an accountable Privacy Owner, and the user has not supplied a complete accountable owner identity or a signing timestamp. The following stage-1 record is populated with every computable evidence value and remains `DEFER` until all required owner-supplied fields are complete.

```text
┌─ OWNER DECISION
│ Gate: D-007 synthetic aggregate-only dry-run authorization
│ Owner name and role: Daniel [FULL NAME], Interim Privacy Owner for Synthetic Evidence
│ Decision: DEFER
│ Date/time (UTC): [OWNER MUST SUPPLY AT SIGNING]
│ Scope and constraints:
│   - Authorization applies only to the named synthetic dataset and exact hashes below.
│   - Authorization applies only to the approved deterministic mapping.
│   - The exact approved cutoff must be used without substitution.
│   - Output is limited to the approved aggregate-only contract.
│   - The operation must be read-only and idempotent.
│   - D-007 deletion execution remains disabled.
│   - D-007 export generation and delivery remain disabled.
│   - The destructive 365-day purge remains disabled.
│   - Provider-side deletion and notifications remain disabled.
│   - D-025 reporting and real-world effects remain disabled.
│   - Pilot and production remain blocked.
│   - Any dataset, mapping, contract, cutoff, commit, or environment change invalidates this authorization.
│ Required evidence references/hashes:
│   - Repository execution-code commit: 31303cd
│   - STAGING deployment: NOT_COMPUTABLE
│   - Synthetic dataset: d007-retention-boundary-fixture v1.0.0
│   - Synthetic dataset SHA-256: 8e7480e1f87ed68370a93f757d88b40135651bada242983574d96d71726c760e
│   - Deterministic mapping: deterministic-mapping-v1.json v1.0.0
│   - Deterministic mapping SHA-256: 90c96397594110072c1ddbc94c2d087f06071e4110db7afa5fda6288b64fd048
│   - Exact cutoff: 2026-08-29T12:00:00.000Z
│   - Aggregate contract: aggregate-output-contract-v1.json v1.0.0
│   - Aggregate contract SHA-256: a228cbc4062f3eb429188820ac92b3d0d757d71b62da87a01fadd59767aed614
│   - Execution contract: dry-run-execution-contract-v1.md v1.0.0
│   - Execution contract SHA-256: 8a5ebc16d46e7be74b84558751e8a08b0170585e98f86292fd509547bda6aed9
│   - Preflight invariant report: preflight-invariant-v1.json
│   - Preflight invariant report SHA-256: fa2b3418a367753a1bd896f31c687a5f2bea18457959bf8f0028f0e11198acd7
│ Privacy Owner attestation:
│   I attest that I reviewed the identified synthetic dataset, deterministic
│   mapping, UTC cutoff, and aggregate-only output contract. I authorize one
│   reproducible, read-only synthetic dry run within the stated scope. This
│   authorization does not approve deletion, purge, export generation, export
│   delivery, provider erasure, reporting, real-world effects, pilot launch, or
│   production launch. Any change to the referenced inputs, hashes, cutoff,
│   environment, deployment, or code requires a new authorization.
└─
```

## Missing items that force `DEFER`

1. A complete accountable owner name and an explicit selected decision.
2. An owner-supplied signing timestamp in UTC, generated immediately before signing.
3. A positively identified synthetic-STAGING deployment ID. No such deployment identifier is available from the permitted public status observation.

Until all three items are supplied and all listed hashes are independently verified, this record must not be changed to `ACCEPT` and no dry run may execute.
