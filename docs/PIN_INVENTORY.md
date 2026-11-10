# PIN_INVENTORY.md — SPEC-017 pin audit 2026-09-17 (re-pinned to 0.7.0 on 2026-11-02 and to 0.9.0 on 2026-11-09)

Live runtime pin from `src/release/pins.ts`:

| Identity               | Value                                      |
| ---------------------- | ------------------------------------------ |
| `SPEC_VERSION`         | `0.9.0`                                    |
| `RELEASE_MANIFEST`     | `RELEASE_MANIFEST-0.9.0.md`                |
| `SPECS_COMMIT`         | `208705cfd2b6aa1ce913ac9e70a2d42a1c9487ad` |
| `API_VERSION`          | `v0`                                       |
| `EVENT_SCHEMA_VERSION` | `0.1.0`                                    |

`.env.example`, CI `verify`, `wrangler.jsonc` vars, `worker-deploy.yml`, and the staging workflows all carry the same two values. `tests/unit/deploy-pins.test.ts` fails `npm run verify` if any of them differs from `src/release/pins.ts`, because the Worker fails startup when `SUAS_SPEC_VERSION` differs from the build pin.

## Living docs repaired the same day

These no longer advertise `0.2.0` as the current pin:

`AGENTS.md`, `README.md` start-here, `FABLE_HANDOFF.md`, `CONTEXT.md`, `IMPLEMENTATION_BOOTSTRAP.md`, `SPEC017_PLAN.md`, `SPEC017_NEXT.md`, `docs/readiness/env-config-matrix.md`, `docs/runbooks/deployment-rollback.md`, `docs/readiness/spec-runtime-consistency-audit.md`, `src/release/pins.ts` comments.

`suas-specs` STATUS “Next stage” no longer says pin `0.4.0`.

## Living docs re-pinned to 0.9.0 on 2026-11-09

The same pin lines as the 0.7.0 re-pin below, plus `docs/PIN_INVENTORY.md` itself. `SPECS_COMMIT` is the suas-specs #71 squash-merge commit that carries tag `v0.9.0`. The `0.8.0` release (tag `v0.8.0`) was never pinned on its own.

## Living docs re-pinned to 0.7.0 on 2026-11-02

`AGENTS.md`, `README.md` start-here, `CONTEXT.md`, `FABLE_HANDOFF.md`, `IMPLEMENTATION_BOOTSTRAP.md`, `SPEC017_PLAN.md` and `SPEC017_NEXT.md` (pin lines only), `docs/readiness/env-config-matrix.md`, `docs/readiness/spec-runtime-consistency-audit.md`, `docs/runbooks/deployment-rollback.md`, `docs/slices/WORKER_RUNTIME.md` (living pin note), `package.json` description. The application version line now separates tag `v0.2.0` (implements `0.6.0`) from `main` (pins `0.7.0`, unreleased).

## Still historical — leave `0.2.0` on the page

Slice records that landed under D-011, `docs/SPEC017_COMPLETION_AUDIT.md`, Wave B citations, `sv-001.ts` citations of `RELEASE_DECISIONS-0.2.0.md`.

## Also refreshed 2026-09-17

- `docs/legal/privacy-notice.md` authority line → stack `0.6.0` (dated legal draft; not re-pinned, since the `0.7.0` manifest lists no privacy artifact)
- `docs/readiness/gate-matrix.md` stack line → `0.6.0` (evidence assessed at `0.6.0`)
- Join / chat / metrics pages exist; they do not invent product
- `POST /api/v0/cases` is registered
