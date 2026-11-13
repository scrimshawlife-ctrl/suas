# SUAS

Shut Up and Serve (SUAS) is the web and API implementation repository for the consent-governed veteran support coordination platform specified in [`scrimshawlife-ctrl/SUAS-specs`](https://github.com/scrimshawlife-ctrl/SUAS-specs). Native iOS and Android clients consume this repository's `/api/v0`.

Public site: https://scrimshawlife-ctrl.github.io/suas/

Product UI preview (static Pages HTML, not live operations):
https://scrimshawlife-ctrl.github.io/suas/app.html

iOS operator-loop demo (interactive synthetic Pages surface, no API connection):
https://scrimshawlife-ctrl.github.io/suas/ios-operator.html

The former `demo.html` URL remains as a compatibility redirect to the Product UI preview.

## Start here

**Fable:** read [FABLE_HANDOFF.md](FABLE_HANDOFF.md), then [CONTEXT.md](CONTEXT.md), [AGENTS.md](AGENTS.md), [SPEC017_PLAN.md](SPEC017_PLAN.md), and [SPEC017_NEXT.md](SPEC017_NEXT.md).

Canonical released specs:

- specification stack: `0.9.0`
- specs merge pin: `208705cfd2b6aa1ce913ac9e70a2d42a1c9487ad` (`src/release/pins.ts`)
- manifest: `RELEASE_MANIFEST-0.9.0.md`
- current stage: `SPEC-018` (blocked); SPEC-017 evidence recorded against pin `0.6.0`
- implementation authority: `RELEASED_FOR_IMPLEMENTATION`
- pilot readiness: `NOT_READY`
- production readiness: `NOT_READY`
- pin audit: [docs/PIN_INVENTORY.md](docs/PIN_INVENTORY.md)
- application version: `0.2.0` (`package.json`). Tag `v0.2.0` implements SUAS-specs `0.6.0`. `main` pins the released spec `0.9.0` (tag `v0.9.0`); its application changes since `v0.2.0` are not released yet (see [CHANGELOG.md](CHANGELOG.md) `[Unreleased]` and [RELEASING.md](RELEASING.md))
- work tracking: [SUAS Product Board](https://github.com/users/scrimshawlife-ctrl/projects/6) (all four repositories)

## Product surfaces

`SUAS-specs` is canonical. This repository is the web and API implementation. Keep all three implementation repositories in future considerations:

| Repository                                                                              | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`scrimshawlife-ctrl/suas`](https://github.com/scrimshawlife-ctrl/suas) (this repo)     | Fastify JSON API `/api/v0` (`src/`), React web app (`web/`), AWS CDK infrastructure (`infra/`, not deployed). The Cloudflare Worker and its Neon staging database are retired (R11.6). Legacy HTML `/app`. OpenAPI document `docs/openapi/v0.json` (not served live). `/api/v0` auth is an opaque Bearer session credential; `/app` also accepts a session cookie (`SameSite=Strict`; `SameSite=None` only when `SUAS_CORS_ALLOWED_ORIGINS` is non-empty). Cross-origin access follows `SUAS_CORS_ALLOWED_ORIGINS` (D-038, released in spec 0.7.0). Synthetic STAGING moves to `https://api.staging.suasqrf.com` (API) and `https://staging.suasqrf.com` (web) once the CDK stacks are deployed. |
| [`scrimshawlife-ctrl/suas-ios`](https://github.com/scrimshawlife-ctrl/suas-ios)         | Native iOS client (private Swift). Consumes `/api/v0`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| [`scrimshawlife-ctrl/suas-android`](https://github.com/scrimshawlife-ctrl/suas-android) | Native Android client (Kotlin scaffold). Consumes `/api/v0`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

Native client contract: [`MOBILE_SURFACE.md`](https://github.com/scrimshawlife-ctrl/SUAS-specs/blob/main/MOBILE_SURFACE.md) (D-033).

Native apps consume this API. Do not add `/api/mobile` or a second version selector. HTML `/app/*` commands are the browser surface; they are not the mobile contract. Do not add a Flutter, React Native, or Kotlin Multiplatform harness in this repository.

If you change `/api/v0`, auth, environment class, or a Veteran journey, consider both `suas-ios` and `suas-android`.

## Repository layout

| Path                   | What it is                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/`                 | Fastify app (`src/app.ts`), `/api/v0` routes (`src/http/routes/`), domain modules and adapters. `src/main.ts` runs it on Node.                         |
| `src/aws/`             | AWS Lambda entries for the job worker, migrations and WebSocket push. The API Lambda runs `src/main.ts` behind the Lambda Web Adapter.                 |
| `web/`                 | React single-page app for v1 (Vite). A separate package: see [web/README.md](web/README.md).                                                           |
| `infra/`               | AWS CDK app for v1 synthetic STAGING in `us-west-2`. Synthesized and tested offline only; nothing is deployed. See [infra/README.md](infra/README.md). |
| `migrations/`          | SQL migrations. The expected schema version is `EXPECTED_SCHEMA_VERSION` in `src/db/schema-version.ts`.                                                |
| `docs/openapi/v0.json` | The `/api/v0` contract. `npm run openapi:check` compares it with the registered routes; `web/` generates its client types from it.                     |

## Local development

Requirements: Node.js 22.13 or newer and a reachable PostgreSQL 17 instance.

```bash
npm ci
cp .env.example .env
echo "SUAS_SESSION_SECRET=$(openssl rand -hex 32)" >> .env
createdb suas_local
npm run migrate -- apply
npm run dev
```

`SUAS_SESSION_SECRET` is required in every environment class and startup fails
closed without it. It ships empty in `.env.example` and must never be committed.

After every pull, run `npm ci` again (and `cd web && npm ci` for the web app): a
dependency added since your last install, such as a new AWS SDK client, otherwise
crashes `npm run dev`. Startup also refuses a `.env` whose `SUAS_SPEC_VERSION` or
`SUAS_RELEASE_MANIFEST` differs from `src/release/pins.ts`; after a re-pin, copy
both values from `.env.example`.

### Web app

`web/` talks to this API over `/api/v0`. Start the API in LOCAL mode, then run
`cd web && npm ci && npm run dev`. The LOCAL settings it needs are in
[web/README.md](web/README.md).

### One-command demo (`npm run dev:demo`)

Brings up the Node server (`src/main.ts`) locally from a clean clone with migrations applied and
the synthetic demo seed loaded. LOCAL only: it refuses non-loopback database
hosts, never targets staging or any production host, and all data is synthetic
(`@example.invalid` emails, 555-0100 to 555-0199 phone numbers).

Requirements: Node.js 22.13 or newer and PostgreSQL 17 on localhost with a `suas` / `suas`
role that can create databases. If Postgres is not reachable and Docker is
running, the script starts the `suas-postgres17-local` container; otherwise it
prints install steps.

```bash
npm ci
npm run dev:demo            # Node server (src/main.ts) on http://127.0.0.1:3000
npm run dev:demo -- --reset # drop and recreate the suas_demo database first
npm run smoke:demo          # second terminal: end-to-end smoke over /api/v0
```

What it does: creates `suas_demo` (override with `SUAS_DEMO_DATABASE_URL`),
runs `migrate apply` and `migrate validate`, runs `src/cli/seed-demo.ts`, writes
a session secret and the seed summary to the gitignored `.local-secrets/`, then
starts `src/main.ts` with `SUAS_ENV=LOCAL`, fake email and SMS, against the
local database.

| Item             | Value                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------- |
| Base URL         | `http://127.0.0.1:3000` (`/api/v0`, web `/app`)                                             |
| Android emulator | `http://10.0.2.2:3000`                                                                      |
| iOS Simulator    | `http://localhost:3000`                                                                     |
| Demo sign-in     | `demo@example.invalid`, code `123456` (open case, four service requests)                    |
| New Veteran      | `newvet@example.invalid` (enrolled, no case yet)                                            |
| Sign-in method   | `EMAIL_OTP`                                                                                 |
| Other codes      | `curl "http://127.0.0.1:3000/api/v0/dev/last-challenge?destination=newvet@example.invalid"` |

To try the Intake Assistant locally, start with `SUAS_MODEL_INFERENCE_MODE=fake` and queue
scripted turns (`{"turns": [...]}`) with `POST /api/v0/dev/model-inference/turns` (LOCAL only,
answers `409` unless the model is the scripted fake). To let a new email address sign up, set
`SUAS_BROWSER_TENANT_ID` to the tenant new people join.

The fixed code `123456` works only for `demo@example.invalid`. Three gates
must all pass (`src/auth/demo-fixed-code.ts`): `SUAS_ENV=LOCAL`, the opt-in
`SUAS_DEMO_FIXED_CODE=enabled` that `npm run dev:demo` sets, and a loopback
database URL. The sign-in page shows the email and code, and no email is
required. TEST and PRODUCTION reject the flag, and STAGING never issues the
code. Every other account
still gets a random code. The same `123456` is the code for the Android and
iOS no-server demo modes.

`/api/v0/dev/*` exists only when `SUAS_ENV=LOCAL` and returns 404 on staging.
The pilot sign-in limit (three codes per account per 15 minutes) still applies;
re-running `npm run dev:demo` or `npm run seed:demo` clears the window for the
synthetic `@example.invalid` accounts only. That reset is strictly LOCAL:
`src/cli/demo-rate-limits.ts` refuses unless `SUAS_ENV=LOCAL` and the database
host is loopback (`localhost`, `127.0.0.1`, `::1`), so it can never run against
staging or any shared database.

`contract/demo-fixtures.json` is owned here. `npm run demo:fixtures` regenerates
it from the running LOCAL demo server; the Android and iOS apps keep copies of
this export and must not hand-edit them.

The native apps have matching demo modes that use the same accounts and code:

| Client  | No server (in-memory fixture)                               | Real client against this LOCAL server                    |
| ------- | ----------------------------------------------------------- | -------------------------------------------------------- |
| Android | debug launcher "SUAS Demo (no server)" (`DemoRootActivity`) | debug launcher "SUAS Local Worker" (`LocalRootActivity`) |
| iOS     | shared Xcode scheme `Demo` (`-SUASDemoMode`, DEBUG)         | shared Xcode scheme `Local` (`-SUASLocal`, DEBUG)        |

Details live in the
[suas-android README](https://github.com/scrimshawlife-ctrl/suas-android#demo-modes-debug-builds-only)
and the [suas-ios README](https://github.com/scrimshawlife-ctrl/suas-ios#demo-modes-debug-builds-only).
Release builds of both apps contain neither the fixture nor the demo entry
points.

Seeded for the demo Veteran: one open case with TRANSPORTATION (MATCHING), FOOD
(FULFILLED, ready to confirm), SHELTER (CANCELLED) and PEER_SUPPORT (CREATED)
requests; synthetic resources in all four categories; an ACTIVE consent grant,
a trusted contact, notifications, a completed Check-In and a Veteran follow-up.
The legacy `/app/chat` page shows its unavailable state and nothing is seeded
for chat; v1 chat is in `/api/v0` (`src/http/routes/chat.ts`) and `web/`.

`npm run demo:fixtures -- --out contract/demo-fixtures.json` captures the same
seeded `/api/v0` responses into the deterministic fixture file the iOS and
Android no-server demo modes load. Identifiers and timestamps are rewritten,
and the script refuses any non-synthetic email or phone number. Export from a
fresh seed (`npm run dev:demo -- --reset`, then `npm run demo:fixtures` before
`npm run smoke:demo`), because the smoke test creates and cancels an extra
request.

### Local demo workflow

The repeatable LOCAL workflow uses the isolated `suas-postgres17-local` Docker
container, applies and validates migrations, refreshes synthetic seed sessions,
and starts the real Fastify runtime. It never resets the database or enables
external effects:

```bash
scripts/start-local.sh
```

To start the runtime and open an authenticated visible Chromium surface:

```bash
scripts/start-local.sh veteran
scripts/start-local.sh admin
```

The equivalent browser-only commands use the latest protected seed output while
the server is already running:

```bash
npm run demo:local:veteran
npm run demo:local:admin
```

On Windows PowerShell use `.\scripts\start-local.ps1 -Role veteran` (or
`admin`). The browser helper rejects non-LOCAL environments,
non-loopback URLs, and credentials that are not present in the gitignored
`.local-secrets/seed-output.json` or an explicit session environment variable.

The static GitHub Pages Product UI preview is available at
`https://scrimshawlife-ctrl.github.io/suas/app.html`. It shows the veteran,
responder, and admin surfaces with synthetic display data only. It does not
connect to the API, issue sessions, or represent an operating environment.

Commands:

| Command                           | Purpose                                                |
| --------------------------------- | ------------------------------------------------------ |
| `npm run verify`                  | format check, lint, typecheck, and the full test suite |
| `npm run build`                   | compile to `dist/`                                     |
| `npm start`                       | run the compiled build                                 |
| `npm run dev`                     | run from source with reload                            |
| `npm test`                        | full suite (integration tests need PostgreSQL)         |
| `npm run test:unit`               | unit tests only, no database required                  |
| `npm run test:e2e:staging`        | Chromium acceptance against synthetic STAGING          |
| `npm run test:e2e:staging:public` | public STAGING acceptance without credentials          |
| `npm run soak:staging`            | fixed read-only synthetic-STAGING soak                 |
| `npm run migrate -- status`       | applied, pending, drifted, and orphaned migrations     |
| `npm run migrate -- apply`        | apply pending migrations under an advisory lock        |
| `npm run migrate -- validate`     | verify schema state without mutating it                |
| `npm run provenance`              | print the build-info object                            |
| `npm run privacy:deletion-drill`  | synthetic deletion path against the TEST database      |
| `npm run dev:demo`                | one-command LOCAL demo server with migrations and seed |
| `npm run smoke:demo`              | smoke over the main `/api/v0` endpoints (LOCAL only)   |
| `npm run seed:demo`               | re-run the synthetic demo seed against `.env`          |
| `npm run demo:fixtures`           | capture native demo fixtures from the LOCAL server     |

Integration tests use two databases, created once:

```bash
createdb suas_test
createdb suas_migrations_test
```

`suas_test` is shared by the suites and is migrated automatically before the run. The
migration-harness tests rebuild a schema from empty, so they own `suas_migrations_test`
separately. Override either with `TEST_DATABASE_URL` and `TEST_MIGRATIONS_DATABASE_URL`.

## AWS (v1 target)

`infra/` is the CDK app for v1 synthetic STAGING in `us-west-2`
(`V1_PROJECT_PLAN.md` §6 in SUAS-specs, a proposal). It defines a DNS stack, a
web stack (S3 and CloudFront for `web/dist`) and a backend stack (RDS PostgreSQL
17 behind RDS Proxy; API, job worker and migrate Lambdas; HTTP API; EventBridge
Scheduler). Nothing is deployed and there is no deploy workflow; STAGING deploys
are run by hand with CDK ([docs/runbooks/deployment-rollback.md](docs/runbooks/deployment-rollback.md)).
`cd infra && npm ci && npm run check` typechecks, tests and synthesizes it
offline. Details: [infra/README.md](infra/README.md).

## Synthetic STAGING

STAGING is the AWS CDK app above. The Cloudflare Worker and its Neon database,
the pre-v1 STAGING host at `https://suasqrf.com`, were retired on 2026-11-12
(R11.6, specs #75, contributor proposal, not released), together with
`wrangler.jsonc` and the Worker and Neon workflows. Evidence recorded against
the Worker stays under `docs/readiness/evidence/` as written. PRODUCTION remains
rejected until SPEC-018, and no real support-provider effects are authorized.
This repository does not claim production readiness.

Pinned formal STAGING evidence is under
`docs/readiness/evidence/staging-soak-2026-08-27/`. The settlement command is an
evidence gate, not a standalone static check: `npm run settle:check` requires
`full-verify.log` and `ci-run.txt` under `SUAS_SETTLE_SCRATCH` for the current
HEAD.

Browser acceptance (`npm run test:e2e:staging`) runs by hand against the origin
in `SUAS_E2E_BASE_URL`; no workflow schedules it. Install Chromium once with
`npx playwright install chromium`, then run the public suite without
credentials. Authenticated routes are opt-in via fresh gitignored synthetic seed
sessions in `SUAS_E2E_VETERAN_BEARER`, `SUAS_E2E_RESPONDER_BEARER`, and
`SUAS_E2E_ADMIN_BEARER`, and are skipped when those are absent. Never supply
production sessions or real veteran data.

### Fixed-profile synthetic-STAGING soak

`npm run soak:staging` runs by hand (its workflow was retired with the Neon
staging) against `SUAS_E2E_BASE_URL` with `SUAS_E2E_VETERAN_BEARER` and
`SUAS_E2E_RESPONDER_BEARER`. It does not provision or deploy anything, and it
requires `SUAS_SOAK_CONFIRM=synthetic-staging-read-only`.

The canonical profile is one warm-up VU for 5 minutes, 5 VUs for 120 minutes,
10 VUs for 15 minutes, then up to 15 minutes to drain in-flight requests. The
duration settings default to those values and may only shorten them,
which permits brief harness checks without silently expanding the approved
workload. VU counts, one-second pacing, and the route mix are fixed in code.

The route mix contains only `GET` requests: public health, the authenticated
resource catalog, veteran self, and responder unassigned-case reads. The command
fails closed unless deletion, export delivery, 365-day purge, sensitive
reporting, real effects, pilot launch, and production launch remain disabled or
blocked. It never invokes command routes, provider effects, reporting release,
export delivery, or deletion.

The artifact at `artifacts/soak/synthetic-staging-soak-summary.json` contains
only aggregate request counts, HTTP status counts, sanitized error categories,
p50/p95/p99/max latency, fixed request identifiers, drain counts, and GET retry
totals. Each GET attempt is recorded, including recovered `503`/`500`. Transient
`503`/`500` are retried up to two times; recovered 5xx stay in the status and
retry aggregates and do not fail the job. Exhausted 5xx, 4xx, timeouts, and
network errors still fail the run. A retry delay is abortable and is rechecked
against drain before another attempt, so peak drain cannot start a new fetch.
Response bodies, bearer credentials, request headers, and raw exception
messages are not recorded. A passing run is stability evidence only and keeps
capacity at `NOT_COMPUTABLE`; it is not a production-readiness or
production-capacity claim.

Do not run the soak until the synthetic-STAGING deployment and operator
authorization prerequisites in
`docs/readiness/evidence/synthetic-staging-2026-08-29/soak/status.md` are met.

The full `/api/v0` surface, with the authorization each operation needs, is in
[docs/openapi/v0.json](docs/openapi/v0.json).

## Environment

`.env.example` maps the released [SUAS-specs `ENVIRONMENT.md`](https://github.com/scrimshawlife-ctrl/SUAS-specs/blob/main/ENVIRONMENT.md) contract.

Logical classes are `LOCAL`, `TEST`, `STAGING`, `PRODUCTION`. LOCAL/TEST/STAGING must not use real veteran data or real external support effects. Invalid environment/feature combinations must fail closed at startup.

## Release boundary

v0.9.0 authorizes implementation but not production operation.

Production-unavailable until later decision/evidence closure:

- production infrastructure and real veteran data/live pilot;
- production Support Signal compute (`SUAS_SUPPORT_SIGNAL_MODE` stays `disabled|fixture`);
- real transportation/shelter/food/external peer providers;
- production workload/SLO/RTO/RPO targets;
- sensitive aggregate reporting.

Manual/fake/test adapters are valid where the release permits them.

## Governing rules

1. `SUAS-specs` is canonical; code does not redefine it.
2. Every implementation PR cites released spec file/section, stack version, manifest, and relevant test/readiness contract.
3. Semantic gaps return to specs rather than becoming implementation defaults.
4. Preserve the MVP visual/interaction identity and required truthful degraded/no-availability states.
5. Provider SDKs/statuses/payloads stay behind adapters; domain modules use SUAS-owned ports.
6. Preserve stateless/shared correctness state, durable async-work semantics, persistent idempotency, tenant isolation, replay-safe events, and bounded access paths.
7. No automated emergency dispatch, diagnosis, suicidality determination, or safety-critical generative AI.
8. Do not claim HIPAA compliance or production readiness from release/implementation alone.
9. If you change `/api/v0`, auth, environment class, or a Veteran journey, consider both `suas-ios` and `suas-android`. Native clients consume `/api/v0`. Do not add `/api/mobile`. Do not treat HTML `/app/*` commands as the mobile contract.

See [FABLE_HANDOFF.md](FABLE_HANDOFF.md), [CONTEXT.md](CONTEXT.md), [AGENTS.md](AGENTS.md), [IMPLEMENTATION_BOOTSTRAP.md](IMPLEMENTATION_BOOTSTRAP.md), [SPEC017_PLAN.md](SPEC017_PLAN.md), and [SPEC017_NEXT.md](SPEC017_NEXT.md).

Skill source selection, migration and safe checks: [SKILL_PROVENANCE.md](SKILL_PROVENANCE.md).
