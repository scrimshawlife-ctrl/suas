# PIN_INVENTORY.md — SPEC-017 pin audit 2026-09-17

Live runtime pin from `src/release/pins.ts`:

| Identity               | Value                                      |
| ---------------------- | ------------------------------------------ |
| `SPEC_VERSION`         | `0.6.0`                                    |
| `RELEASE_MANIFEST`     | `RELEASE_MANIFEST-0.6.0.md`                |
| `SPECS_COMMIT`         | `fb27e54114c003c15f7bc74254e0c26c0da1ec0a` |
| `API_VERSION`          | `v0`                                       |
| `EVENT_SCHEMA_VERSION` | `0.1.0`                                    |

`.env.example`, wrangler vars, and CI match.

## Living docs repaired the same day

These no longer advertise `0.2.0` as the current pin:

`AGENTS.md`, `README.md` start-here, `FABLE_HANDOFF.md`, `CONTEXT.md`, `IMPLEMENTATION_BOOTSTRAP.md`, `SPEC017_PLAN.md`, `SPEC017_NEXT.md`, `docs/readiness/env-config-matrix.md`, `docs/runbooks/deployment-rollback.md`, `docs/readiness/spec-runtime-consistency-audit.md`, `src/release/pins.ts` comments.

`suas-specs` STATUS “Next stage” no longer says pin `0.4.0`.

## Still historical — leave `0.2.0` on the page

Slice records that landed under D-011, `docs/SPEC017_COMPLETION_AUDIT.md`, Wave B citations, `sv-001.ts` citations of `RELEASE_DECISIONS-0.2.0.md`.

## Also refreshed 2026-09-17

- `docs/legal/privacy-notice.md` authority line → current stack `0.6.0`
- `docs/readiness/gate-matrix.md` stack line → `0.6.0`
- Join / chat / metrics pages exist; they do not invent product
- `POST /api/v0/cases` is registered
