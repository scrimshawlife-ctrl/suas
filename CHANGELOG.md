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

### CI

- Moved Node 20 actions to their current Node 24 majors (`actions/checkout@v7`,
  `actions/setup-python@v7`, `actions/upload-artifact@v7`,
  `actions/configure-pages@v6`, `actions/upload-pages-artifact@v5`,
  `actions/deploy-pages@v5`), pinned every `ubuntu-latest` job to
  `ubuntu-24.04`, and pinned `worker-deploy` to wrangler `4.148.0`. No behavior
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
