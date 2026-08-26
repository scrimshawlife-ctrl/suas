# Compute host — Cloudflare Workers: conformance record

**Released spec stack:** `0.2.0`
**Release manifest:** `RELEASE_MANIFEST-0.2.0.md`
**Specs merge:** `4a722e69ad8f7ff45a9581ca3bdd022bdf524f8f`
**Stage:** `SPEC-017`
**Production/pilot readiness:** `NOT_READY` (unchanged)

Scope is the compute host for the existing Fastify app. This record does not
close D-001–D-005, D-006, D-022, or SPEC-018. It does not claim a live Worker
or production operation.

## 1. Released spec citations

| Spec                        | Sections relied on                                                                                                                                       |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ENVIRONMENT.md`            | §2 environment class, §3 configuration variables, §5 fail-closed startup, §6 secret classes, §7 repository files, §8 provenance, §9 schema compatibility |
| `ARCHITECTURE.md`           | §3 invariants 1–2 and 5, §13 finite timeouts, §14 observability                                                                                          |
| `API.md`                    | §2 `/api/v0`, §6 error body, §8 correlation                                                                                                              |
| `HANDOFF.md`                | §2 production prohibited, §5 repository hygiene                                                                                                          |
| `RELEASE_MANIFEST-0.2.0.md` | Readiness boundary                                                                                                                                       |

## 2. Change map — file to spec section

| Path                                  | Implements                                                      |
| ------------------------------------- | --------------------------------------------------------------- |
| `src/worker.ts`                       | ENVIRONMENT.md §5 isolate startup; API.md §2 route host         |
| `src/worker/env.ts`                   | ENVIRONMENT.md §3–§6; Hyperdrive as request-path `DATABASE_URL` |
| `src/http/dispatch.ts`                | Fetch → Fastify `inject()` (no `listen()`)                      |
| `src/db/operating-schema.ts`          | ENVIRONMENT.md §9 version-only validate on the request path     |
| `src/app.ts`                          | `runtime: 'worker'` refuses listen/apply                        |
| `src/resilience/outbound-fetch.ts`    | ARCHITECTURE.md §13 outbound timeout                            |
| `wrangler.jsonc`                      | Non-secret vars; placeholder Hyperdrive id                      |
| `docs/runbooks/cloudflare-workers.md` | Operator steps without credentials                              |

## 3. Evidence

| Invariant                                                               | Evidence                                     |
| ----------------------------------------------------------------------- | -------------------------------------------- |
| Worker fetch serves `/app` HTML and `/api/v0/health` without `listen()` | `tests/integration/worker-fetch.test.ts`     |
| Hyperdrive connection string is the request-path `DATABASE_URL`         | `tests/unit/worker-env.test.ts`              |
| Unpooled `DATABASE_URL` Worker secret is ignored                        | same file                                    |
| `SUAS_MIGRATIONS_MODE=apply` is rejected on the Worker path             | same file; `startApp({ runtime: 'worker' })` |
| Schema version other than 11 fails closed; no DDL                       | `tests/unit/operating-schema.test.ts`        |
| Missing Hyperdrive returns 503 `NOT_READY` without secrets              | `tests/integration/worker-fetch.test.ts`     |
| Outbound adapter `fetch` carries a timeout signal                       | `tests/unit/outbound-fetch.test.ts`          |
| No Fly files; no connection strings in `wrangler.jsonc`                 | `tests/unit/repository-hygiene.test.ts`      |

## 4. Environment and configuration changes

No new `ENVIRONMENT.md` §3 variable names. Worker isolates map wrangler `vars`
and secrets through the existing schema. `DATABASE_URL` on the request path
comes only from `env.HYPERDRIVE.connectionString`. `.env.example` documents
that the Node CLI still uses the unpooled URL.

`.dev.vars.example` documents `SUAS_SESSION_SECRET` as empty. `wrangler.jsonc`
`vars` stay non-secret and keep `SUAS_ALLOW_REAL_EXTERNAL_EFFECTS=false`,
email/SMS `sink`, and `SUAS_MIGRATIONS_MODE=validate`.

## 5. Migration notes

No schema change. Expected version remains `11`. Apply stays on
`npm run migrate` with the unpooled URL.

## 6. Idempotency and failure behavior

Existing command idempotency, fulfillment retry classification, and job
dispatch are unchanged. The Worker wrapper caches a successful isolate start
and retries start after a failed start. Dispatch errors do not rebuild the
app. Startup failures return 503 and do not serve routes.

## 7. Security and privacy impact

- Hyperdrive connection strings and session secrets are not in git.
- Worker error bodies omit raw driver text that might include hosts.
- Structured Worker logs record method, path, status, duration, and request
  id. They do not record `Authorization` or query strings.
- Pino is disabled on the Worker path so the isolate does not start
  `worker_threads`.

## 8. Availability boundaries preserved

No `UNAVAILABLE`, `MANUAL_ONLY`, `INFORMATION_ONLY`, or `FUTURE` feature is
made operational. Email/SMS stay sink. Real external effects stay false.
`SUAS_ENV=PRODUCTION` stays rejected. D-022 still refuses a durable queue
in STAGING/PRODUCTION. D-006 stays `DECISION_PENDING`. Pages stays static.

## 9. Semantic gaps returned to `SUAS-specs`

None opened by this host change. D-001–D-005 (staging account/secret store)
and D-022 (durable jobs) remain owner decisions. A Cloudflare-hosted
`SUAS_ENV=LOCAL` isolate is an implementation-owned host choice, not a
released environment class.

## 10. Readiness statement

SPEC-017 stays `NOT READY`. SPEC-018 is not authorized. This record does not
claim the Worker is live or that compute is production-ready.
