# PIN_INVENTORY.md — SPEC-017 pin audit 2026-09-17

**Authority:** existing SPEC-017  
**Not authorized by:** D-037  
**Does not change:** Worker behavior, readiness gates, spend

## Live runtime pin (OBSERVED)

From `src/release/pins.ts` on `main` at this audit:

| Identity | Value |
|---|---|
| `SPEC_VERSION` | `0.6.0` |
| `RELEASE_MANIFEST` | `RELEASE_MANIFEST-0.6.0.md` |
| `SPECS_COMMIT` | `fb27e54114c003c15f7bc74254e0c26c0da1ec0a` |
| `API_VERSION` | `v0` |
| `EVENT_SCHEMA_VERSION` | `0.1.0` |

Matching env examples and CI:

- `.env.example`
- `wrangler.jsonc` vars
- `tests/setup.ts`, `tests/helpers/env.ts`
- `.github/workflows/verify.yml`, `worker-deploy.yml`, `staging-acceptance.yml`, `staging-recovery-fixtures.yml`, `synthetic-staging-soak.yml`

`suas-specs` current stack is `0.6.0` ([VERSIONING.md](https://github.com/scrimshawlife-ctrl/suas-specs/blob/main/VERSIONING.md) §2, [RELEASE_MANIFEST-0.6.0.md](https://github.com/scrimshawlife-ctrl/suas-specs/blob/main/RELEASE_MANIFEST-0.6.0.md)). The pin target is not `0.2.0` and is not `0.4.0`.

`SPECS_COMMIT` is the 0.6.0 release provenance SHA. Later specs commits (including D-037 overlay text) are not a stack bump and must not move this pin by themselves.

## Specs-side wording split (returned)

[STATUS.md](https://github.com/scrimshawlife-ctrl/suas-specs/blob/main/STATUS.md) header is `0.6.0`. Its "Next stage" paragraph still said pin `0.4.0`. That sentence is stale leftover from the D-035 release. It is not a second live pin. Repair is editorial on `suas-specs`, not a runtime retarget.

## Living documents that claimed `0.2.0` as the *current* pin

These describe the build an agent should implement today. They must match `pins.ts`.

| File | Finding |
|---|---|
| `AGENTS.md` header | claimed `0.2.0` |
| `README.md` start-here | claimed `0.2.0` |
| `FABLE_HANDOFF.md` | claimed v0.2.0 |
| `CONTEXT.md` released-contract block | claimed `0.2.0` |
| `IMPLEMENTATION_BOOTSTRAP.md` header | claimed `0.2.0` |
| `SPEC017_PLAN.md` header | claimed runtime pin `0.2.0` |
| `SPEC017_NEXT.md` | this audit's first draft repeated the stale claim |
| `docs/readiness/env-config-matrix.md` | `SUAS_SPEC_VERSION` row `0.2.0` |
| `docs/runbooks/deployment-rollback.md` | pin line `0.2.0` |
| `docs/readiness/spec-runtime-consistency-audit.md` | stack row `0.2.0` / aligned |
| `src/release/pins.ts` comments | still named `RELEASE_MANIFEST-0.2.0.md` beside `0.6.0` constants |

## Historical records that should keep `0.2.0`

Slice and scoring records of work done against the D-011 cut. Do not rewrite them as `0.6.0`.

- `docs/slices/SLICE_*.md` stack headers where the slice landed under `0.2.0`
- `docs/SPEC017_COMPLETION_AUDIT.md`
- `docs/SPEC_DESIGN_GAPS.md`, `docs/SPEC_GAP_PLAN.md` citations of Wave B
- `src/signals/sv-001.ts` / `engine.ts` citations of `RELEASE_DECISIONS-0.2.0.md`
- D-011 decision identity itself (`qv-001` / `sv-001` released at `0.2.0`)

`0.2.0` remains a real inherited release. It is not the current stack pin.

## What this PR does not do

- change `SPEC_VERSION` or `RELEASE_MANIFEST` constants
- move the Worker to Google Cloud
- wire join / chat / metrics
- spend credits
- mark any readiness gate `READY`
