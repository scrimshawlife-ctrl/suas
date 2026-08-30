# SUAS

Shut Up and Serve (SUAS) is the web and API implementation repository for the consent-governed veteran support coordination platform specified in [`scrimshawlife-ctrl/SUAS-specs`](https://github.com/scrimshawlife-ctrl/SUAS-specs). Native iOS and Android clients consume this repository's `/api/v0`.

Public site: https://scrimshawlife-ctrl.github.io/suas/

Product UI preview (static Pages HTML, not live operations):
https://scrimshawlife-ctrl.github.io/suas/app.html

iOS operator-loop demo (interactive synthetic Pages surface, no API connection):
https://scrimshawlife-ctrl.github.io/suas/ios-operator.html

The former `demo.html` URL remains as a compatibility redirect to the Product UI preview.

## Start here

**Fable:** read [FABLE_HANDOFF.md](FABLE_HANDOFF.md), then [CONTEXT.md](CONTEXT.md), [AGENTS.md](AGENTS.md), and [SPEC017_PLAN.md](SPEC017_PLAN.md).

Canonical released specs:

- specification stack: `0.2.0`
- specs merge: `4a722e69ad8f7ff45a9581ca3bdd022bdf524f8f`
- manifest: `RELEASE_MANIFEST-0.2.0.md`
- current stage: `SPEC-017` implementation conformance
- implementation authority: `RELEASED_FOR_IMPLEMENTATION`
- pilot readiness: `NOT_READY`
- production readiness: `NOT_READY`

## Product surfaces

`SUAS-specs` is canonical. This repository is the web and API implementation. Keep all three implementation repositories in future considerations:

| Repository                                                                              | Role                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`scrimshawlife-ctrl/suas`](https://github.com/scrimshawlife-ctrl/suas) (this repo)     | TypeScript Cloudflare Worker. JSON API `/api/v0`. HTML `/app`. OpenAPI document `docs/openapi/v0.json` (not served live). Auth is an opaque Bearer session credential, not cookies. Observed synthetic STAGING origin: `https://suasqrf.com`. |
| [`scrimshawlife-ctrl/suas-ios`](https://github.com/scrimshawlife-ctrl/suas-ios)         | Native iOS client (private Swift). Consumes `/api/v0`.                                                                                                                                                                                        |
| [`scrimshawlife-ctrl/suas-android`](https://github.com/scrimshawlife-ctrl/suas-android) | Native Android client (Kotlin scaffold). Consumes `/api/v0`.                                                                                                                                                                                  |

Native client contract: [`MOBILE_SURFACE.md`](https://github.com/scrimshawlife-ctrl/SUAS-specs/blob/main/MOBILE_SURFACE.md) (D-033).

Native apps consume this API. Do not add `/api/mobile` or a second version selector. HTML `/app/*` commands are the browser surface; they are not the mobile contract. Do not add a Flutter, React Native, or Kotlin Multiplatform harness in this repository.

If you change `/api/v0`, auth, environment class, or a Veteran journey, consider both `suas-ios` and `suas-android`.

## Local development

Requirements: Node.js 22+ and a reachable PostgreSQL 17 instance.

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
scripts/start-local.sh responder
scripts/start-local.sh admin
```

The equivalent browser-only commands use the latest protected seed output while
the server is already running:

```bash
npm run demo:local:veteran
npm run demo:local:responder
npm run demo:local:admin
```

On Windows PowerShell use `.\scripts\start-local.ps1 -Role veteran` (or
`responder` / `admin`). The browser helper rejects non-LOCAL environments,
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
| `npm run worker:dev`              | Wrangler local Worker (`src/worker.ts`, no `listen()`) |

Integration tests use two databases, created once:

```bash
createdb suas_test
createdb suas_migrations_test
```

`suas_test` is shared by the suites and is migrated automatically before the run. The
migration-harness tests rebuild a schema from empty, so they own `suas_migrations_test`
separately. Override either with `TEST_DATABASE_URL` and `TEST_MIGRATIONS_DATABASE_URL`.

## Cloudflare Workers

Compute for `/app` and `/api/v0` is a Cloudflare Worker (`wrangler.jsonc`,
`src/worker.ts`). The Worker builds the existing Fastify app once per isolate
with `listen: false` and answers through `inject()`. Native iOS and Android
clients consume `/api/v0` from this Worker; HTML `/app` is not the mobile
contract. GitHub Pages `docs/` stays the static poster and is not the API host.

Request-path Postgres uses **Cloudflare Hyperdrive** and `node-postgres`
(`nodejs_compat`). The isolate reads `env.HYPERDRIVE.connectionString` as
`DATABASE_URL` and forces `SUAS_MIGRATIONS_MODE=validate`. If the recorded
schema version is not `11`, startup fails closed and the fetch handler
returns `503`. Apply migrations with `npm run migrate` against the
**unpooled** URL in `.env`. Never put that URL, a Neon password, or a
Hyperdrive connection string in `wrangler.jsonc`.

Store `SUAS_SESSION_SECRET` with `npx wrangler secret put SUAS_SESSION_SECRET`.
Copy `.dev.vars.example` to `.dev.vars` for `wrangler dev`. Replace
`YOUR_HYPERDRIVE_ID` in `wrangler.jsonc` with the id from
`npx wrangler hyperdrive create` — do not commit connection strings.

The committed `wrangler.jsonc` remains a safe LOCAL template. The formal
synthetic STAGING deployment supplies `SUAS_ENV=STAGING` and the D-022
Postgres-outbox job queue through owner-controlled deployment configuration.
PRODUCTION remains rejected until SPEC-018. Email and SMS stay `sink`, and no
real support-provider effects are authorized. This repository does not claim
production readiness. The shared synthetic topology (GitHub + Worker + Neon) is in
[docs/decision-packets/D-001-005-staging-hosting.md](docs/decision-packets/D-001-005-staging-hosting.md);
owner-authorized publish uses Actions `worker-deploy` (`workflow_dispatch` only)
or `npx wrangler deploy` — see
[docs/runbooks/cloudflare-workers.md](docs/runbooks/cloudflare-workers.md).

Pinned formal STAGING evidence is under
`docs/readiness/evidence/staging-soak-2026-08-27/`. The settlement command is an
evidence gate, not a standalone static check: `npm run settle:check` requires
`full-verify.log` and `ci-run.txt` under `SUAS_SETTLE_SCRATCH` for the current
HEAD.

Browser acceptance defaults to the formal synthetic Worker. Install Chromium
once with `npx playwright install chromium`, then run the public suite without
credentials. Authenticated routes are opt-in via fresh gitignored synthetic seed
sessions in `SUAS_E2E_VETERAN_BEARER`, `SUAS_E2E_RESPONDER_BEARER`, and
`SUAS_E2E_ADMIN_BEARER`. The scheduled `staging-acceptance` workflow uses the
same names as repository secrets and reports those tests as skipped when secrets
are absent. Never supply production sessions or real veteran data.

### Fixed-profile synthetic-STAGING soak

The `synthetic-staging-soak` GitHub Actions workflow is manual-only and uses the
existing `suas-synthetic-staging` Environment variable `SUAS_E2E_BASE_URL` plus
the existing `SUAS_E2E_VETERAN_BEARER` and `SUAS_E2E_RESPONDER_BEARER` secrets.
It does not provision or deploy anything. Dispatch requires the exact
`synthetic-staging-read-only` confirmation.

The canonical profile is one warm-up VU for 5 minutes, 5 VUs for 120 minutes,
10 VUs for 15 minutes, then up to 15 minutes to drain in-flight requests. The
dispatch duration inputs default to those values and may only shorten them,
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
p50/p95/p99/max latency, fixed request identifiers, and drain counts. Response
bodies, bearer credentials, request headers, and raw exception messages are not
recorded. A passing run is stability evidence only and keeps capacity at
`NOT_COMPUTABLE`; it is not a production-readiness or production-capacity claim.

Do not run the soak until the synthetic-STAGING deployment and operator
authorization prerequisites in
`docs/readiness/evidence/synthetic-staging-2026-08-29/soak/status.md` are met.

Cloudflare published limits (not SUAS SLOs): 30 s CPU default on paid plans
(10 ms on free), 128 MB memory, 50 subrequests per invocation on free / 10,000
on paid.

HTTP surface so far:

| Endpoint                                                         | Authorization                           |
| ---------------------------------------------------------------- | --------------------------------------- |
| `GET /api/v0/health`                                             | none; liveness only                     |
| `POST /api/v0/auth/challenges`                                   | none; issues a passwordless challenge   |
| `POST /api/v0/auth/challenges/commands/verify`                   | none; exchanges a code for a session    |
| `POST /api/v0/auth/mfa/challenges`                               | session                                 |
| `POST /api/v0/auth/mfa/challenges/commands/verify`               | session; elevates it                    |
| `POST /api/v0/auth/sessions/commands/logout`                     | session                                 |
| `GET /api/v0/admin/build-info`                                   | SUAS admin, MFA-elevated                |
| `GET /api/v0/admin/adapter-catalog`                              | SUAS admin, MFA-elevated                |
| `GET /api/v0/admin/adapter-configurations`                       | SUAS admin, MFA-elevated; `tenant_id`   |
| `POST /api/v0/admin/adapter-configurations/commands/enable`      | SUAS admin, MFA-elevated                |
| `POST /api/v0/admin/adapter-configurations/commands/disable`     | SUAS admin, MFA-elevated                |
| `POST /api/v0/admin/adapter-configurations/commands/set-routing` | SUAS admin, MFA-elevated                |
| `POST /api/v0/check-ins`                                         | session; starts a Check-In              |
| `GET /api/v0/check-ins/:id`                                      | session; owner only                     |
| `POST /api/v0/check-ins/:id/responses`                           | session; owner only                     |
| `POST /api/v0/check-ins/:id/commands/complete`                   | session; owner only; scores qv-001      |
| `GET /api/v0/cases`                                              | responder; `ownership=unassigned\|mine` |
| `GET /api/v0/cases/:id`                                          | owner or responder                      |
| `POST /api/v0/cases/:id/commands/claim`                          | responder                               |
| `POST /api/v0/cases/:id/commands/assign`                         | org admin; Idempotency-Key              |
| `POST /api/v0/cases/:id/commands/triage`                         | responder or org admin; Idempotency-Key |
| `POST /api/v0/cases/:id/commands/activate`                       | assigned responder; Idempotency-Key     |
| `POST /api/v0/cases/:id/commands/move-to-followup`               | assigned responder; reason              |
| `POST /api/v0/cases/:id/commands/resume-active`                  | assigned responder; Idempotency-Key     |
| `POST /api/v0/cases/:id/commands/escalate`                       | assigned responder; reason              |
| `POST /api/v0/cases/:id/commands/resolve`                        | assigned responder; Settlement content  |
| `POST /api/v0/cases/:id/commands/close`                          | assigned responder or org admin         |
| `POST /api/v0/cases/:id/commands/reopen`                         | org admin; reason                       |
| `GET /api/v0/cases/:id/settlements`                              | owner (veteran-visible) or responder    |
| `GET /api/v0/cases/:id/settlements/:settlement_id`               | owner (veteran-visible) or responder    |
| `GET /app/check-ins`                                             | session; start or resume Check-In       |
| `POST /app/check-ins`                                            | session; start or resume, then 303      |
| `GET /app/check-ins/:id`                                         | session; owner only                     |
| `POST /app/check-ins/:id/responses`                              | session; owner only; then 303           |
| `POST /app/check-ins/:id/commands/complete`                      | session; owner only; then 303           |

## Environment

`.env.example` maps the released [SUAS-specs `ENVIRONMENT.md`](https://github.com/scrimshawlife-ctrl/SUAS-specs/blob/main/ENVIRONMENT.md) contract.

Logical classes are `LOCAL`, `TEST`, `STAGING`, `PRODUCTION`. LOCAL/TEST/STAGING must not use real veteran data or real external support effects. Invalid environment/feature combinations must fail closed at startup.

## Release boundary

v0.2.0 authorizes implementation but not production operation.

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

See [FABLE_HANDOFF.md](FABLE_HANDOFF.md), [CONTEXT.md](CONTEXT.md), [AGENTS.md](AGENTS.md), [IMPLEMENTATION_BOOTSTRAP.md](IMPLEMENTATION_BOOTSTRAP.md), and [SPEC017_PLAN.md](SPEC017_PLAN.md).
