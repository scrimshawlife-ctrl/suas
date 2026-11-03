# Changelog

All notable changes to the SUAS Worker (web `/app` and `/api/v0`) are recorded
here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [Semantic Versioning](https://semver.org/) while it stays
pre-1.0. The application version lives in `package.json` and is reported as
`app_version` by `GET /api/v0/admin/build-info`.

The application version is not the specification stack version. Each release
below states which SUAS-specs stack it implements (SUAS-specs `VERSIONING.md`
section 3). Versions below 1.0.0 mean no production, pilot, or app-store launch:
SPEC-018 is still blocked. Release steps: [RELEASING.md](RELEASING.md).

## [Unreleased]

### Fixed

- Browser sign-in no longer fails with `401 "Cross-origin browser requests are not accepted."` on a same-origin form post. `/app` pages send `referrer-policy: no-referrer`, so browsers send `Origin: null` on those posts; `assertSameOriginBrowserWrite` now accepts `Sec-Fetch-Site: same-origin` before comparing `Origin` to `Host`. Cross-site posts, and `Origin: null` without a same-origin signal, are still rejected. SUAS-specs `AUTH.md` section 9.1 (spec 0.6.0) is unchanged.
- Restored `aria-label="Product preview"` on the homepage product UI preview link and allow-listed the live web app and iOS operator demo links in the public-pages unit test.

### Changed

- **Cross-origin support (SUAS-specs D-038, released in 0.7.0).** New `SUAS_CORS_ALLOWED_ORIGINS` (comma-separated exact origins; empty means off). Allowlisted origins get `Access-Control-Allow-Origin` (exact origin, never `*`), `Vary: Origin`, exposed `x-request-id` / `retry-after` / `location`, and preflight answers (`204`) on every endpoint; `Access-Control-Allow-Credentials: true` is sent for `/app` only because `/api/v0` is Bearer-only. This replaces `assertSameOriginBrowserWrite` (the `Origin: null` fix above) with one global origin policy. Every browser-originated unsafe request (POST/PUT/PATCH/DELETE) on any path must be same-origin (`Sec-Fetch-Site: same-origin`, including `Origin: null`) or come from an allowlisted origin, otherwise `403 FORBIDDEN` before body parsing, authentication, rate limiting, or email. Requests with no `Origin` or `Sec-Fetch-Site` and no `/app` cookie (curl, Postman, native iOS and Android apps) are unaffected; a cookie-authenticated unsafe request with neither header is `403`. Without `Sec-Fetch-Site`, the same-origin `Origin` fallback compares scheme as well as host. The `/app` session cookie stays `Secure; HttpOnly; SameSite=Strict; Path=/app` while the allowlist is empty and is `SameSite=None` only when it is non-empty. Allowlist entries containing `*` (also percent-encoded `%2a`), a trailing-dot host, or an empty host label fail startup closed, as do loopback names and IP literals in STAGING and PRODUCTION. In every environment, TEST included, a non-empty allowlist fails startup under a spec pin below `0.7.0`. Re-pinned to SUAS-specs `0.7.0` (`RELEASE_MANIFEST-0.7.0.md`, `2572520`). **Contract change:** supersedes SUAS-specs `AUTH.md` section 9.1 and `RELEASE_DECISIONS-0.6.0.md` ("cookie-authenticated state-changing `/app` requests reject cross-origin submissions", `SameSite=Strict`). Native clients keep native HTTP and may not use a WebView or browser fetch. Fixed `dispatchToFastify` throwing on a `204` response.
- D-038 follow-ups from the PR #199 re-review. New tests prove `loadConfig` refuses a non-empty `SUAS_CORS_ALLOWED_ORIGINS` under a build pinned below `0.7.0` in TEST, LOCAL and STAGING (`tests/unit/cors-pin-guard-startup.test.ts`), that every `SUAS_SPEC_VERSION` / `SUAS_RELEASE_MANIFEST` in `wrangler.jsonc`, `.env.example` and the workflows equals `src/release/pins.ts` (`tests/unit/deploy-pins.test.ts`), and that `Origin: null` with `Sec-Fetch-Site: same-site` is `403`. Living docs and comments now state stack `0.7.0` and no longer call D-038 proposed or draft; the app-version line separates tag `v0.2.0` (implements `0.6.0`) from `main` (pins `0.7.0`, unreleased). The Pages runbook says only an owner-controlled custom domain may go in `SUAS_CORS_ALLOWED_ORIGINS`, never a Pages preview or shared-hosting origin.
- Tests lock the stop before a provider API: fulfillment does not write `PARTIAL` or call `MARK_UNFULFILLABLE`, provider acceptance records `ACCEPTED` only, and confirmation still refuses `DISPUTED`, `CANCELLED`, and `FAILED`. Food and peer support still use the manual adapter.
- Synthetic staging sign-in accepts `demo@example.invalid` with code `123456` when the Worker deploy sets `SUAS_DEMO_FIXED_CODE=enabled`. The sign-in page shows that account. TEST and PRODUCTION still reject the flag.
- Recorded the 2026-10-08 synthetic STAGING deploys. The live Worker is `80c27e7`.
- The public site homepage links the live web app, the product UI preview, and the iOS operator demo.
- `CONTEXT.md` links the Mac device handoff in SUAS-specs (`docs/handoffs/MAC_DEVICE_WORK.md`).
- `SPEC017_NEXT.md` aligned with HEAD: LOCAL demo and native demo modes listed as shipped, Android harness item cites `MainActivityHarnessTest` (suas-android #16).
- `CONTEXT.md` refreshed: demo mode, path-parameter fix, staging deploy and check, versioning, board link.

### CI

- Moved Node 20 actions to their current Node 24 majors (`actions/checkout@v7`,
  `actions/setup-python@v7`, `actions/upload-artifact@v7`,
  `actions/configure-pages@v6`, `actions/upload-pages-artifact@v5`,
  `actions/deploy-pages@v5`), pinned every `ubuntu-latest` job to
  `ubuntu-24.04`, and pinned `worker-deploy` and
  `recovery-runtime-acceptance` to wrangler `4.148.0`. No behavior
  change.

## [0.2.0] - 2026-10-07

Implements SUAS-specs `0.6.0` (pin `fb27e54`). API selector `/api/v0` and event
schema `0.1.0` are unchanged.

### Added

- One-command LOCAL demo: `npm run dev:demo` applies migrations, loads the
  synthetic demo seed and starts `wrangler dev` on `http://127.0.0.1:3000`
  ([#187](https://github.com/scrimshawlife-ctrl/suas/pull/187)).
- `npm run smoke:demo`, an end-to-end smoke over the main `/api/v0` endpoints
  against the LOCAL demo Worker (#187).
- `npm run demo:fixtures`, which exports `contract/demo-fixtures.json` from the
  LOCAL demo Worker. This repository owns the fixture; `suas-android` and
  `suas-ios` hold copies (#187).
- Easy LOCAL demo sign-in: `demo@example.invalid` with code `123456`, and
  `newvet@example.invalid` for an enrolled Veteran with no case. The fixed code
  needs `SUAS_ENV=LOCAL`, `SUAS_DEMO_FIXED_CODE=enabled` and a local database;
  config rejects the flag outside LOCAL
  ([#189](https://github.com/scrimshawlife-ctrl/suas/pull/189)).
- `staging-path-param-check` workflow. It runs after each successful
  `worker-deploy` (or by hand) and fails if a path-parameter route on synthetic
  STAGING answers `400`
  ([#188](https://github.com/scrimshawlife-ctrl/suas/pull/188)).
- This changelog and [RELEASING.md](RELEASING.md).

### Fixed

- Path-parameter routes such as `GET /api/v0/cases/{id}/service-requests`
  returned `400 VALIDATION_FAILED` under the Workers runtime because the
  `find-my-way` patch produced null params. The patch now builds params without
  `new Function()` (#187). Synthetic STAGING (`https://suasqrf.com`) was
  deployed at `0f7aeae` on 2026-10-07 and the path-parameter check passed with
  `200` on both checked routes.

### Changed

- The LOCAL demo seed clears sign-in rate limits for synthetic
  `@example.invalid` accounts only, and only against a loopback database (#187).

## [0.1.0] - 2026-09-30

Baseline: `main` at `e3a9a16` (#186), the last commit before 0.2.0 work. The
`package.json` version was `0.1.0` from SPEC-017 Slice 1 (2026-08-18) until
then. Implements SUAS-specs `0.6.0` (pin `fb27e54`).

### Added

- TypeScript Cloudflare Worker serving the JSON API `/api/v0` and the HTML
  `/app` surface, with Hyperdrive Postgres and fail-closed configuration.
- Email OTP sign-in with Bearer sessions for API and native clients, and a
  cookie session for `/app` (SUAS-specs `0.6.0`, D-004).
- SPEC-017 implementation evidence against pin `0.6.0`
  (`docs/SPEC017_COMPLETION_AUDIT.md`).
- Synthetic STAGING deploy through the manual `worker-deploy` workflow.

[Unreleased]: https://github.com/scrimshawlife-ctrl/suas/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/scrimshawlife-ctrl/suas/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/scrimshawlife-ctrl/suas/releases/tag/v0.1.0
