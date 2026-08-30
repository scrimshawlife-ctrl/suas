# AGENTS.md — SUAS implementation rules

Released stack: `0.2.0`  
Manifest: `RELEASE_MANIFEST-0.2.0.md` in `SUAS-specs`  
Authority: `RELEASED_FOR_IMPLEMENTATION`  
Stage: `SPEC-017`

Read `FABLE_HANDOFF.md` and `CONTEXT.md` first.

## Product surfaces

`SUAS-specs` is canonical. This repository is the web and API implementation. Keep all three implementation repositories in future considerations:

| Repository                                                                              | Role                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`scrimshawlife-ctrl/suas`](https://github.com/scrimshawlife-ctrl/suas) (this repo)     | TypeScript Cloudflare Worker. JSON API `/api/v0`. HTML `/app`. OpenAPI document `docs/openapi/v0.json` (not served live). Auth is an opaque Bearer session credential, not cookies. Observed synthetic STAGING origin: `https://suasqrf.com`. |
| [`scrimshawlife-ctrl/suas-ios`](https://github.com/scrimshawlife-ctrl/suas-ios)         | Native iOS client (private Swift). Consumes `/api/v0`.                                                                                                                                                                                        |
| [`scrimshawlife-ctrl/suas-android`](https://github.com/scrimshawlife-ctrl/suas-android) | Native Android client (Kotlin scaffold). Consumes `/api/v0`.                                                                                                                                                                                  |

Native client contract: `MOBILE_SURFACE.md` (D-033) in [`scrimshawlife-ctrl/SUAS-specs`](https://github.com/scrimshawlife-ctrl/SUAS-specs).

Native apps consume this API. Do not add `/api/mobile` or a second version selector. HTML `/app/*` commands are the browser surface; they are not the mobile contract. Do not add a Flutter, React Native, or Kotlin Multiplatform harness in this repository.

If you change `/api/v0`, auth, environment class, or a Veteran journey, consider both `suas-ios` and `suas-android`.

## Rules

1. `SUAS-specs` is canonical; draft/unreleased future changes are not authority.
2. Every implementation PR cites released spec file/section, stack version, manifest, and test/readiness contract.
3. Semantic gaps return to specs; do not invent product/domain behavior.
4. Follow released `ENVIRONMENT.md`; LOCAL/TEST/STAGING cannot use real veteran data or real external support effects.
5. Keep canonical terms exact: Support Case, Service Request, Referral, Fulfillment Attempt, Fulfillment, Follow-Up, Settlement, Consent Grant, Support Signal, etc.
6. Provider SDKs/payloads/statuses/webhook schemas stay in adapters. Domain modules use SUAS-owned capability ports.
7. Manual/fake coordination remains valid where real providers are unavailable.
8. Correctness-critical state is shared/persistent, not process-local.
9. Async handlers are replay-safe; at-least-once delivery must not duplicate observable business effects.
10. External mutations use stable idempotency identity; ambiguous outcomes reconcile before risky retry.
11. Tenant isolation covers API, DB, jobs, caches, adapters, reports, and admin.
12. Provider disclosure uses use-time authorization/consent and minimum-necessary projection.
13. Preserve released MVP visual/interaction behavior and truthful degraded/no-availability states.
14. No automated emergency dispatch, diagnosis, suicide prediction, or safety-critical generative behavior.
15. Do not add vendor, capacity, SLO, recovery, legal/compliance, partner, staffing, scoring, crisis-copy, or reporting-threshold assumptions that remain unavailable.
16. Build provenance must expose app commit/version, spec version, manifest, environment, and schema/migration version where applicable.
17. Never commit secrets, `.env`, real contact details, provider credentials, or production data.
18. SPEC-018 evidence is required before any production readiness claim.
19. If you change `/api/v0`, auth, environment class, or a Veteran journey, consider both `suas-ios` and `suas-android`. Native clients consume `/api/v0`. Do not add `/api/mobile`. Do not treat HTML `/app/*` commands as the mobile contract.

## Per-slice record

Each SPEC-017 slice records released spec references, files/packages changed, tests/evidence, migration/environment changes, unavailable/manual-only boundaries touched, and any gap returned to specs.

No code/config change may silently upgrade an `UNAVAILABLE`, `MANUAL_ONLY`, `INFORMATION_ONLY`, or `FUTURE` feature to production-operational behavior.

## Cursor Cloud specific instructions

Standard commands live in `README.md` (command table) and `package.json` scripts; prefer those. The notes below are non-obvious caveats for this cloud environment. The startup update script runs `npm ci` only; everything else below is a per-session/manual step.

- Runtime: Node.js 22 (present) and PostgreSQL 17 (installed from the PGDG apt repo). The `suas` role (password `suas`) and the `suas_local`, `suas_test`, and `suas_migrations_test` databases already exist.
- PostgreSQL is not managed by systemd here. Start it once per fresh VM boot before running migrations, tests, or the dev server: `sudo pg_ctlcluster 17 main start` (check with `pg_lsclusters`). `suas_local` is already migrated to the current schema version.
- The app does NOT auto-load `.env`; it reads `process.env` directly. Before `npm run dev`, `npm run migrate`, or `npm run provenance`, export the file into the shell: `set -a; . ./.env; set +a` (or invoke node/tsx with `--env-file=.env`). Without this, startup fails closed listing every missing variable. `.env` already exists (git-ignored) with a generated `SUAS_SESSION_SECRET`; if missing, recreate it per the README "Local development" block. After a spec re-pin, also set `SUAS_SPEC_VERSION` and `SUAS_RELEASE_MANIFEST` in that file to the values in `src/release/pins.ts` — a stale pin fails closed even when every other variable is present.
- Tests are self-contained: `tests/setup.ts` pins its own `SUAS_ENV=TEST` config and points at `suas_test` / `suas_migrations_test`, so `npm test`, `npm run test:unit`, and `npm run verify` run WITHOUT sourcing `.env` (but PostgreSQL must be running for anything beyond `test:unit`). The shared test DB is migrated automatically by the vitest global setup.
- Dev server listens on `127.0.0.1:3000` (`SUAS_HTTP_HOST`/`SUAS_HTTP_PORT`). Public UI is under `/app`; the JSON API is under `/api/v0`. Native iOS and Android clients consume `/api/v0`, not HTML `/app/*` commands. Authenticated surfaces require an `Authorization: Bearer <session-credential>` header (there is no cookie/UI session), so authenticated pages are not reachable by plain browser navigation.
- In LOCAL/TEST the challenge-delivery channel is fake/sink, so OTP codes are never emitted or retrievable over HTTP; drive full login flows through the integration tests or by minting a session with the domain `createSession` helper against `suas_local` (synthetic data only — ENVIRONMENT.md §2).
- D-012 is `DECIDED` (v0.1.5). TEST/CI stay on `SUAS_SAFETY_COPY_MODE=placeholder_test_only` and must keep that default — do not switch the verify workflow or `tests/setup.ts` to `approved`. To see 911/988 copy locally, export `SUAS_SAFETY_COPY_MODE=approved` in the shell that starts the app. `ARRIVED` has no recorded domain fact today and must stay unshown.
- D-011 is `DECIDED` (v0.2.0) for `qv-001` + `sv-001`. TEST/CI stay on `SUAS_SUPPORT_SIGNAL_MODE=fixture`. Do not add a production scoring mode or claim live compute. APPLY_EFFECTIVE_SIGNAL transcribes SAFETY.md §3.2: a settled effective `RED` opens or updates a Support Case; non-RED is a no-op; CLOSED is not reopened. Do not add real provider adapters here.
