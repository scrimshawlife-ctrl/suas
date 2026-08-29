# synthetic-data

## Purpose
Generate and execute reproducible privacy-safe SUAS runtime fixtures against real contracts and adapters.

## Trigger
Use for fixture generation, deterministic test datasets, aggregate-only dry runs, provider sandbox scenarios, deletion/export validation, and evidence requiring exact inputs.

## Inputs
- Governing spec/test/evidence contract from `SUAS-specs`.
- Current runtime/environment restrictions.
- Required cases, mappings, projections, and expected outputs.

## Procedure
1. Read `CONTEXT.md`, `AGENTS.md`, `ENVIRONMENT.md` authority, and the relevant contract.
2. Build deterministic synthetic records only; never use real veteran or production data in prohibited environments.
3. Use deterministic IDs/values and a pinned seed when generation is required.
4. Cover positive, negative, boundary, NO_HIT/empty, malformed, replay, duplicate, and cross-tenant cases as applicable.
5. Materialize policy-sensitive states such as consent, retention, deletion, export, and reporting eligibility when required.
6. Execute fixtures against actual runtime contracts/adapters rather than documentation-only examples.
7. Record dataset identity, generator identity, seed, mapping identity, exact cutoff where applicable, expected-output reference, and cryptographic hashes.
8. Verify regeneration produces identical evidence-relevant data and expected outputs.

## Output schema
```yaml
dataset_id: string
version: string
environment: string
generator_id: string|null
seed: string|null
dataset_hash: string
mapping_id: string|null
mapping_hash: string|null
cutoff_utc: string|null
runtime_commit: string
cases_executed: [string]
result: PASS|FAIL|NOT_COMPUTABLE
evidence: [string]
production_authority: false
```

## Completion criteria
Complete only when fixtures are deterministic, executable, hashed, cover all required cases, and results are tied to current runtime provenance.