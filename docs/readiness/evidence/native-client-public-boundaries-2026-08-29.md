# Native-client public-boundary acceptance — 2026-08-29 PT

**Scope:** synthetic STAGING only. No real Veteran data, production authorization, or real external support effects.

## Change under acceptance

- Runtime merge: `aaaf59964493ab3f6e8c82de775d7b1eeac47100` ([PR #126](https://github.com/scrimshawlife-ctrl/suas/pull/126)).
- Acceptance-harness merge: `d8efc7a3e6250b5572b1dba1cc32f663dc514be3` ([PR #127](https://github.com/scrimshawlife-ctrl/suas/pull/127)).
- Authorized Worker deployment: [run 33286664254](https://github.com/scrimshawlife-ctrl/suas/actions/runs/33286664254), passed.
- Authenticated deployed-STAGING acceptance: [run 33286839142](https://github.com/scrimshawlife-ctrl/suas/actions/runs/33286839142), 7 passed and 1 elevated-admin check skipped.

## Observed public behavior

The same boundary matrix was exercised against both:

- `https://suas-synthetic-staging.suas.workers.dev`
- `https://suasqrf.com`

| Request | Observed | Meaning |
|---|---:|---|
| `GET /api/v0/health` | `200` | PostgreSQL configured; job queue configured as durable `postgres-outbox`. |
| unauthenticated `POST /api/v0/cases` with `Idempotency-Key` | `401` | The JSON command is registered and fails closed without a session. Before deployment this request returned `404`. |
| `GET /openapi.json` | `404` | The Worker does not expose a live OpenAPI document; clients pin repository `docs/openapi/v0.json`. |
| `GET /api/v0/dev/last-challenge` | `404` | LOCAL captured-code sign-in is unavailable on shared STAGING. |
| `POST /api/v0/dev/service-requests/{id}/simulate` | `404` | LOCAL simulation is unavailable on shared STAGING. |
| `OPTIONS /api/v0/cases` with a foreign Origin | `404`, no `Access-Control-Allow-Origin` | Native clients use native HTTP; browser cross-origin fetch is not a supported integration. |
| `GET /app` | `200` | Browser HTML remains a separate public surface. |

The authenticated Playwright acceptance used a workflow-minted synthetic Veteran session against the deployed Worker and observed:

1. `POST /api/v0/cases` returned `200` or `201` with a non-closed Support Case.
2. Repeating the command with the same `Idempotency-Key` returned `200`, the same `case_id`, and `replayed: true`.
3. `GET /api/v0/veterans/me` projected the same `open_case.case_id`.

This closes the runtime/public-Worker integration loop for the D-033 native case-open dependency.

## Other public surfaces

| Surface | Observed | Boundary |
|---|---:|---|
| `https://scrimshawlife-ctrl.github.io/suas/` | `200` | Static GitHub Pages presentation; no `/api/v0` reference was present in returned HTML. |
| `https://suasqrf.org/app/` | `200` | Distinct legacy demo (`App Demo | SUAS Veteran Crisis Q.R.F.`), not the accepted Worker/native-client surface. |

## Native-client disposition

- iOS draft: [scrimshawlife-ctrl/suas-ios#2](https://github.com/scrimshawlife-ctrl/suas-ios/pull/2). Runtime prerequisite is publicly accepted. Merge remains blocked on Xcode build, simulator/device workflow, and human accessibility review. D-034 remains open.
- Android draft: [scrimshawlife-ctrl/suas-android#2](https://github.com/scrimshawlife-ctrl/suas-android/pull/2). Unsupported claims are removed. Merge remains blocked on Android SDK build, emulator/device workflow, and human accessibility review.
- `scrimshawlife-ctrl/noema-client` is a client for the Noema Agent MUD and does not implement the SUAS `/api/v0` or opaque-Bearer contract. It is therefore not a valid substitute client for this boundary. The deployed Playwright/APIRequest acceptance exercises the actual SUAS HTTP contract instead.

## Claims not made

- No production, pilot, application-store, or real-Veteran readiness claim.
- No iOS or Android build/device acceptance claim.
- No screen-reader or human workflow sign-off claim.
- No CORS/browser-client support claim.
