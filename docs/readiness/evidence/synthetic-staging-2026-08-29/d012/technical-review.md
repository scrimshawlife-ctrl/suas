# D-012 safety-copy technical review

## Canonical source and implementation

- Canonical inventory: `../SUAS-specs/SAFETY_COPY.md`, version `0.1.5`.
- Runtime implementation: `src/ui/safety.ts`, `src/ui/surfaces.ts`, `src/http/routes/resources.ts`, `src/http/routes/ui.ts`, and notification templates.
- Config schema constrains `SUAS_SAFETY_COPY_MODE` to `placeholder_test_only`, `approved`, or `disabled`, and rejects unofficial modes.
- Committed STAGING configuration uses `placeholder_test_only`, not a claim of approved live safety-copy release.

## Technical checks recorded

- Correct canonical copy renders only for approved mode.
- Placeholder/disabled paths do not present copy as official.
- Emergency destinations are limited to canonical 911/988 guidance.
- Forbidden implication checks and state truthfulness tests pass.
- Safety escalation overrides ordinary guidance where specified.
- Failure state offers a non-promissory alternative action and does not conceal urgent guidance.
- Required copy version/provenance is present where the route contract defines it.

## Local verification result

- Timestamp: `2026-08-29T03:56:28Z`
- Command scope: bounded D-012/D-025/config/integration/invariant test suite.
- Result: `10` test files and `258` tests passed, exit code `0`.
- Sanitized record: `../logs-sanitized/local-safety-reporting-result.json`.
- Scope limitation: local source validation only. It does not verify a deployed copy surface or supply an attributable human decision.

No canonical copy was rewritten. Human Safety Reviewer approval remains required regardless of automated results.
