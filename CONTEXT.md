# CONTEXT.md: SUAS implementation context

Read this before implementation work.

## What SUAS is

Shut Up and Serve is a consent-governed veteran support coordination platform.

Mission: coordinate the shortest safe and consented path between a veteran's current need and an available human or material support resource.

Canonical loop:

`SIGNAL → NEED → CONSENT → COORDINATION → FULFILLMENT → FOLLOW-UP → SETTLEMENT`

MVP categories:

- `FOOD`
- `TRANSPORTATION`
- `SHELTER`: temporary shelter/accommodation, not permanent housing
- `PEER_SUPPORT`

## What SUAS is not

- EHR
- diagnosis system
- suicide-prediction product
- automated emergency-dispatch system
- clinical efficacy measurement product
- production billing/Medi-Cal system

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

Specs are authority. Implementation gaps return to specs.

Every SUAS repository has a `CONTEXT.md`: [suas-ios](https://github.com/scrimshawlife-ctrl/suas-ios/blob/main/CONTEXT.md), [suas-android](https://github.com/scrimshawlife-ctrl/suas-android/blob/main/CONTEXT.md), [SUAS-specs](https://github.com/scrimshawlife-ctrl/SUAS-specs/blob/main/CONTEXT.md). Work across all four is tracked on the [SUAS Product Board](https://github.com/users/scrimshawlife-ctrl/projects/6).

## Released implementation contract

- spec version: `0.6.0`
- release manifest: `RELEASE_MANIFEST-0.6.0.md`
- specs merge pin: `fb27e54114c003c15f7bc74254e0c26c0da1ec0a` (`src/release/pins.ts`)
- implementation authority: `RELEASED_FOR_IMPLEMENTATION`
- current implementation stage: `SPEC-018` (blocked); SPEC-017 evidence recorded against pin `0.6.0`
- production/pilot readiness: `NOT_READY`
- pin audit: [docs/PIN_INVENTORY.md](docs/PIN_INVENTORY.md)

Use `FABLE_HANDOFF.md`, `AGENTS.md`, `SPEC017_PLAN.md`, and `SPEC017_NEXT.md` in this repo, then the released `HANDOFF.md` and `ENVIRONMENT.md` in `SUAS-specs`.

## Current state: 2026-10-07

- Application version: `0.2.0` (`package.json`, reported as `app_version` by build-info). Implements SUAS-specs `0.6.0`. Tags `v0.1.0` (baseline, `e3a9a16`) and `v0.2.0` (`a68eb12`) have GitHub Releases. Versions stay below 1.0.0 while SPEC-018 is blocked (SUAS-specs `VERSIONING.md` section 8).
- Release flow: record changes in [CHANGELOG.md](CHANGELOG.md), follow [RELEASING.md](RELEASING.md), tag `vX.Y.Z` on `main` only after an approved merge. `.github/workflows/release.yml` creates the GitHub Release from the CHANGELOG section. A tag never deploys.
- LOCAL demo: `npm run dev:demo` applies migrations, loads the synthetic demo seed, and starts `wrangler dev` on `http://127.0.0.1:3000`. `npm run smoke:demo` checks the main `/api/v0` endpoints. Sign in as `demo@example.invalid` with code `123456`; `newvet@example.invalid` is enrolled with no case. The fixed code needs `SUAS_ENV=LOCAL`, `SUAS_DEMO_FIXED_CODE=enabled`, and a local database (`src/auth/demo-fixed-code.ts`). The same opt-in is allowed on the synthetic STAGING Worker, which shows the code on the sign-in page. TEST and PRODUCTION reject the flag. Every other account gets a random code.
- Demo fixtures: this repo owns `contract/demo-fixtures.json` and regenerates it with `npm run demo:fixtures`. `suas-android` and `suas-ios` hold copies that are not hand-edited.
- `/api/v0/dev/*` exists only when `SUAS_ENV=LOCAL` and returns 404 on staging.
- Path-parameter fix (#187): under Workers, routes such as `GET /api/v0/cases/{id}/service-requests` used to get null params and answer `400`. `patches/find-my-way+9.8.0.patch` now builds params without `new Function`.
- Synthetic STAGING is `https://suasqrf.com`, running `0f7aeae` since 2026-10-07. It is deployed only when an owner runs the `worker-deploy` workflow by hand (`workflow_dispatch`, confirm input `deploy`, environment `suas-synthetic-staging`). After each successful deploy, `staging-path-param-check` calls path-parameter routes with the synthetic bearers and fails on any `400`; its first run passed with `200`s.
- Runbook: [docs/runbooks/cloudflare-workers.md](docs/runbooks/cloudflare-workers.md). Board: [SUAS Product Board](https://github.com/users/scrimshawlife-ctrl/projects/6).
- Mac device work (Simulator, emulator, screenshots, local-runner CI): SUAS-specs [docs/handoffs/MAC_DEVICE_WORK.md](https://github.com/scrimshawlife-ctrl/SUAS-specs/blob/main/docs/handoffs/MAC_DEVICE_WORK.md)

## Handoff state: 2026-08-29 (D-007 evidence packet)

The repository contains a **synthetic-STAGING evidence packet only**. It is not a pilot or production release, and it has no real-world effects.

- Evidence packet root: `docs/readiness/evidence/synthetic-staging-2026-08-29/`.
- D-007 implementation and evidence commits: `398601e`, `e306f87`, `31303cd`, and `0a73017`.
- The D-007 stage-1 owner record is deliberately `DEFER_REQUIRED` at `docs/readiness/evidence/synthetic-staging-2026-08-29/d007/pre-execution/owner-decision-defer-required.md`.
- No D-007 dry run has executed. Do not convert the record to `ACCEPT` or run it without a complete accountable owner identity, selected decision, owner-generated UTC signing timestamp, positively identified synthetic-STAGING deployment ID, and independent verification of every frozen hash.
- Stage 2 evidence acceptance is separate from Stage 1 authorization. Its template is `d007/pre-execution/post-execution-acceptance-template.md`.
- The former shared-account Cloudflare Workers host is retired for SUAS. (Since then, synthetic STAGING runs on the independently owned `https://suasqrf.com`; see Current state.) Do not use it for browser acceptance, deployment evidence, VA OAuth callback registration, or any new integration. A new independently owned SUAS Cloudflare account/subdomain or custom staging hostname must be provisioned outside the repository before STAGING deployment work resumes.
- Browser acceptance has no committed hostname default. Its `SUAS_E2E_BASE_URL` and deployment credentials belong only in GitHub Environment `suas-synthetic-staging` after the independent hostname is provisioned and verified.

The following controls remain mandatory and must stay unchanged absent separate authorization:

```text
D007_DELETION_EXECUTION=disabled
D007_EXPORT_DELIVERY=disabled
D007_365_DAY_PURGE=disabled
D025_REPORTING=disabled
REAL_WORLD_EFFECTS=disabled
PILOT_LAUNCH=blocked
PRODUCTION_LAUNCH=blocked
```

### Machine and platform handoff

- Remote: `origin` → `https://github.com/scrimshawlife-ctrl/suas.git`.
- Default branch: `main`.
- Preserve unrelated working-tree files `.gitignore` and `.ignore`. They pre-date this handoff and are not part of the evidence packet.
- On a new machine: clone the repository, fetch `origin`, check out `main`, run `npm ci`, then run `npm run evidence:preflight` and the targeted D-007 tests before reviewing or continuing.
- Never place secrets, deployment credentials, personal data, or real provider configuration in this repository or its evidence packet.

## Architecture

Default architecture is a scalable modular monolith with:

- stateless application instances;
- PostgreSQL logical system of record;
- durable async-work abstraction;
- persistent command idempotency;
- replay-safe Domain Events;
- provider-neutral capability ports;
- Manual/Fake adapters before real provider adapters;
- strict tenant isolation;
- bounded/paginated growing APIs.

## Core domain distinctions

Do not alias:

- Check-In ≠ Support Signal
- Support Case ≠ Service Request
- Referral ≠ Service Request
- Assignment ≠ Fulfillment
- Fulfillment Attempt ≠ Fulfillment
- Follow-Up ≠ Case Note
- Settlement ≠ Fulfillment or clinical outcome

## UX reference

The existing SUAS MVP is the visual/interaction reference. Preserve its action-first veteran/QRF/resource/responder/admin experience. Required production divergences include truthful availability, no unsupported proximity guarantee, no continuous GPS requirement, no hidden future-category workflow, and no unapproved safety copy.

## Current production-unavailable surfaces

Do not make operational by implementation default:

- real production infrastructure/provider side effects;
- real veteran data/live pilot;
- production Support Signal scoring;
- official safety/crisis copy as the TEST/CI default;
- real external transportation/shelter/food/peer provider adapters;
- production SLO/RTO/RPO targets;
- sensitive aggregate reporting.

## Engineering rule

Prefer the simplest implementation mechanism that proves the released invariant. Do not introduce distributed-system complexity without measured need and a released spec change.
