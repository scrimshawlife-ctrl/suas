# adversarial-testing

## Purpose
Execute deterministic negative-path tests against SUAS runtime boundaries that must fail closed.

## Trigger
Use for auth/authorization, tenant isolation, replay/idempotency, provider failures, disabled modes, malformed input, ambiguous mutations, reporting/admin access, and boundary-sensitive changes.

## Inputs
- Governing security/domain contract from `SUAS-specs`.
- Current runtime commit/build/schema identities.
- Surface inventory: API, DB, jobs, caches, adapters, reports, admin.
- Authorized synthetic credentials and expected failure behavior.

## Procedure
1. Read `CONTEXT.md`, `AGENTS.md`, security/auth/environment authority, and applicable release contract.
2. Enumerate applicable cases: unauthenticated, unauthorized, wrong-role, wrong-tenant, stale/revoked credential, malformed input, replay, duplicate delivery, unavailable provider, disabled feature, timeout, and ambiguous provider outcome.
3. Execute each case against every relevant boundary carrying scoped state.
4. Capture response/result, persistence delta, external-effect delta, audit/provenance output, and retry behavior.
5. Verify rejected operations create no unauthorized persistent or external business effect.
6. Verify retries are idempotent and ambiguous mutations reconcile before risky retry.
7. Record cross-tenant negatives across API, DB, async jobs, caches, adapters, reports, and admin where those surfaces exist.
8. Tie every result to current runtime provenance.

## Output schema
```yaml
test_set_id: string
environment: string
runtime_commit: string
schema_version: string|null
cases:
  - id: string
    boundary: string
    attack: string
    result: PASS|FAIL|NOT_COMPUTABLE
    response_evidence: string|null
    persistent_effect: NONE|UNAUTHORIZED|EXPECTED|NOT_COMPUTABLE
    external_effect: NONE|UNAUTHORIZED|EXPECTED|NOT_COMPUTABLE
    audit_evidence: string|null
cross_tenant_coverage: [string]
findings: [string]
verdict: PASS|FAIL|NOT_COMPUTABLE
```

## Completion criteria
Complete only when every applicable fail-closed boundary has executed negative evidence or is marked NOT_COMPUTABLE with the missing prerequisite identified.