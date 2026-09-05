# SUAS runtime agent skill execution framework

This framework applies to every project-local runtime skill under `skills/*/SKILL.md`.

## Required SKILL.md frontmatter

```yaml
---
name: <kebab-case>
description: 'Use when <trigger>. <What this skill does; non-empty, at most 1024 characters>.'
version: 1.0.0
kind: runtime
status: active
authority: released-runtime-conformance
inputs: [<logical input names>]
outputs: [<logical output names>]
fail_closed: true
self_test: skills/self-tests/<name>.yaml
---
```

## Execution contract

1. Read runtime context and resolve released `SUAS-specs` authority before execution.
2. Validate required inputs and current runtime provenance. Missing authority-critical input returns `NOT_COMPUTABLE`.
3. Execute only the declared procedure and explicitly composed skills.
4. Tie evidence to current commit/build/schema/config/environment identities.
5. Preserve `OBSERVED` versus `INFERRED` provenance and never promote implementation state into authority.
6. Emit the skill-specific output plus the common result envelope below.
7. Run the declared self-test fixture when the skill or output contract changes.

## Common result envelope

```yaml
skill:
  name: string
  version: string
execution_id: string
executed_at_utc: string
authority:
  spec_version: string|null
  manifest: string|null
runtime:
  commit: string|null
  build: string|null
  schema: string|null
  environment: string|null
inputs_resolved: boolean
result: PASS|FAIL|PARTIAL|NOT_COMPUTABLE|DECISION_PENDING
observed: [string]
inferred: [string]
evidence: [string]
missing: [string]
warnings: [string]
```

## Composition

Composition is explicit and fail-closed. A downstream skill may consume another skill's result but may not strengthen its verdict.

Recommended order where applicable:

`synthetic-data -> contract-validation -> adversarial-testing/accessibility-audit/recovery-test -> evidence-gate`

## Self-test rule

Each `skills/self-tests/<name>.yaml` contains `skill`, `scenario`, `given`, `expect`, and `must_not`. A self-test passes only if every expected condition is satisfied and every prohibited condition remains false.
