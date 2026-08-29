# accessibility-audit

## Purpose
Execute accessibility verification against the actual released SUAS client surface and produce reviewable evidence.

## Trigger
Use for UI/client changes, staging route validation, accessibility regressions, or readiness gates requiring accessibility evidence.

## Inputs
- Released UI/MVP and safety-copy authority from `SUAS-specs`.
- Current runtime commit/build identity and environment.
- Route/surface inventory, viewport/device matrix, and required automated/human criteria.

## Procedure
1. Read `CONTEXT.md`, `AGENTS.md`, released UI/MVP authority, safety-copy requirements, and applicable readiness contract.
2. Resolve exact build, routes, environment, and viewport/device under review.
3. Run automated checks for semantic structure, accessible names/labels, contrast, structural errors, and other machine-testable criteria.
4. Perform or prepare required human checks for keyboard/focus, reading/order comprehension, zoom/reflow, reduced motion where applicable, error communication, and safety-copy presentation.
5. Capture tool/version, browser/client, viewport/device, route, build provenance, findings, screenshots/logs where appropriate, and evidence references.
6. Keep automated and human-review dispositions separate.
7. Invalidate evidence when the tested surface changes materially.
8. Never settle a required human-review gate from automation alone.

## Output schema
```yaml
audit_id: string
runtime_commit: string
build_identity: string
environment: string
surfaces: [string]
viewport_or_device: string
automated:
  tool: string
  version: string
  result: PASS|FAIL|PARTIAL|NOT_COMPUTABLE
  evidence: string|null
human_review:
  reviewer: string|null
  completed: boolean
  result: PASS|FAIL|PARTIAL|NOT_COMPUTABLE
  evidence: string|null
findings: [string]
verdict: PASS|FAIL|PARTIAL|NOT_COMPUTABLE
```

## Completion criteria
Complete only when automated and human-review requirements are separately classified and tied to current build provenance.