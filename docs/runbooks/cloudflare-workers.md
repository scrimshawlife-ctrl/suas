# Cloudflare Workers compute

This Worker hosts the existing Fastify `/app` and `/api/v0` surfaces. GitHub
Pages `docs/` stays the static poster. This runbook does not authorize
PRODUCTION or SPEC-018. Interim `SUAS_ENV=LOCAL` soak is allowed after the
owner checklist; it is not STAGING.

## What runs where

| Path                        | Host                                | Persistence                                               |
| --------------------------- | ----------------------------------- | --------------------------------------------------------- |
| `GET /app`, `GET /api/v0/*` | Cloudflare Worker (`src/worker.ts`) | Hyperdrive pooled URL (`env.HYPERDRIVE.connectionString`) |
| `npm run migrate`           | Node CLI on your machine            | Unpooled `DATABASE_URL` in `.env`                         |
| Public poster               | GitHub Pages (`docs/`)              | None                                                      |

Do not point Pages Functions at this API. Do not add Fly or a second orchestrator.

## Platform limits (Cloudflare published)

These are Cloudflare's published Worker limits, not SUAS SLOs (D-021 is open):

| Limit                             | Workers Free | Workers Paid (default)                                  |
| --------------------------------- | ------------ | ------------------------------------------------------- |
| CPU time per request              | 10 ms        | 30 seconds (raise up to 5 minutes with `limits.cpu_ms`) |
| Memory                            | 128 MB       | 128 MB                                                  |
| Subrequests per invocation        | 50           | 10,000                                                  |
| Simultaneous outgoing connections | 6            | 6                                                       |

Hyperdrive queries and outbound `fetch` calls count as subrequests. Waiting on
the database does not consume CPU time.

## Secrets and Hyperdrive

1. Create a Hyperdrive config that points at the existing Neon database. Use
   the **pooled** Neon URL when you create Hyperdrive. Keep the **unpooled**
   Neon URL only in local secret storage for `npm run migrate`.

   ```bash
   npx wrangler hyperdrive create suas-neon --connection-string="postgresql://USER:PASSWORD@HOST/DB"
   ```

   Replace the placeholder values. Do not commit the command output.

2. Put the returned Hyperdrive id into `wrangler.jsonc` under
   `hyperdrive[0].id`, replacing `YOUR_HYPERDRIVE_ID`. The id is not a
   password; still do not paste connection strings into that file.

3. Store the session secret with Wrangler, not in `vars`:

   ```bash
   npx wrangler secret put SUAS_SESSION_SECRET
   ```

   For `npx wrangler dev`, copy `.dev.vars.example` to `.dev.vars` and set
   `SUAS_SESSION_SECRET`. Do not set `DATABASE_URL` there.

4. Stamp provenance as non-secret vars when you publish a shared build:
   `SUAS_BUILD_COMMIT`, `SUAS_BUILD_TIMESTAMP`.

## Schema

The Worker isolate starts with `SUAS_MIGRATIONS_MODE=validate` and only
SELECTs the recorded schema version. It fails closed if that version is not
`11`. It never applies migrations and never creates tables.

Apply schema changes from Node:

```bash
set -a; . ./.env; set +a
npm run migrate -- apply
npm run migrate -- validate
```

Use the unpooled URL in `.env` for those commands.

## Environment class

`wrangler.jsonc` sets `SUAS_ENV=LOCAL` because that is the only class that
can start the HTTP path while D-022 (durable jobs) is open. `STAGING` and
`PRODUCTION` still fail closed on the in-memory queue. `PRODUCTION` also
stays rejected until SPEC-018. Do not set
`SUAS_ALLOW_REAL_EXTERNAL_EFFECTS=true`.

Email and SMS stay `sink`. The Resend EmailPort exists in code and is not
selected. If a later released email mode can select Resend, store
`RESEND_API_KEY` with `wrangler secret put`. Do not put that key in `vars`.
Do not commit a from-address mailbox. Do not add Twilio.

## Local Worker

```bash
npx wrangler dev
```

`wrangler dev` needs a Hyperdrive id and, for local Postgres, a
`localConnectionString` that you add in an uncommitted override. Do not
commit a Neon URL.

Node `npm run dev` still listens on `127.0.0.1:3000` for the existing test
workflow.

## Health

`GET /api/v0/health` is liveness after the isolate starts. If configuration
or schema validation fails, the fetch handler returns `503` with
`{ "error": { "code": "NOT_READY" } }` and does not serve `/app` or `/api/v0`.

## Shared synthetic deploy (interim LOCAL soak)

Topology recommendation: [D-001-005-staging-hosting.md](../decision-packets/D-001-005-staging-hosting.md).

### Status (2026-08-26)

Owner-authorized interim **LOCAL** Worker soak is live on
`https://suas.zer0state-noema.workers.dev` (`SUAS_ENV=LOCAL`). Smoked:

- `GET /api/v0/health` → `200` (`status: ok`, DB configured, job queue
  `in-memory-fake`)
- `GET /app` → `200` HTML

This is **not** STAGING, **not** PRODUCTION, and **not** SPEC-018 gate
closure. Formal `SUAS_ENV=STAGING` still waits on D-022. Real external
effects stay off (`SUAS_ALLOW_REAL_EXTERNAL_EFFECTS=false`, email/SMS
`sink`).

Committed `wrangler.jsonc` keeps `YOUR_HYPERDRIVE_ID`. Live deploys use
gitignored `wrangler.synthetic.jsonc` (real Hyperdrive id + build stamp).
Do not commit connection strings or that override file.

### Request path on Workers

Production entry (`src/worker.ts`) uses Cloudflare's Node HTTP bridge:

- Fastify `listen({ host: '127.0.0.1', port: 8787 })` — port is a routing
  key, not a TCP bind
- `handleAsNodeRequest(8787, request)` from `cloudflare:node`

Node/vitest uses `src/worker/test-fetch.ts` with Fastify `inject()`
(`listen: false`). Do not import `src/worker.ts` from tests (Workers-only
modules).

`find-my-way` ships a `patches/find-my-way+9.8.0.patch` (applied via
`postinstall` / `patch-package`) so prefix matching does not call
`new Function` under the Workers isolate. Wrangler also sets
`allow_eval_during_startup` for remaining constraint compilers that fall
back safely when codegen is denied.

Persistence on Workers uses a **Client-per-query** adapter (`createPool(...,
'worker')`), not a retained `pg.Pool`. Hyperdrive is the network pooler;
reusing TCP clients across requests triggers Workers cross-request I/O
errors (CF 1101). Node/CLI keeps a normal `pg.Pool`.

### Owner checklist (repeat for a new synthetic DB)

1. Neon synthetic database created (no production data path).
2. Hyperdrive created against the **pooled** Neon URL; id only in
   gitignored `wrangler.synthetic.jsonc` or the CF dashboard — never a
   connection string in git. Committed file keeps `YOUR_HYPERDRIVE_ID`.
3. Schema applied once from Node with the **unpooled** URL:
   `npm run migrate -- apply` then `npm run migrate -- validate`.
4. `npx wrangler secret put SUAS_SESSION_SECRET --config wrangler.synthetic.jsonc`.
5. Optional stamp: `SUAS_BUILD_COMMIT` / `SUAS_BUILD_TIMESTAMP` as Wrangler vars.
6. Publish: `npx wrangler deploy --config wrangler.synthetic.jsonc` (manual)
   or the `worker-deploy` workflow (`workflow_dispatch` only) after
   `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` exist in the GitHub
   Environment `synthetic-worker`.

Keep `SUAS_ENV=LOCAL` until D-022. Do not set
`SUAS_ALLOW_REAL_EXTERNAL_EFFECTS=true`. Do not treat this publish as
SPEC-018 production authorization or formal STAGING-class gate closure.

Smoke after deploy:

```bash
curl -sS "$WORKER_BASE_URL/api/v0/health"
curl -sS -o /dev/null -w "%{http_code}\n" "$WORKER_BASE_URL/app"
```

Expect health JSON without secrets; `/app` HTML for the reference surfaces.

### Seed synthetic demo data (Neon unpooled)

With `.env` pointing at the **unpooled** Neon URL (`SUAS_ENV=LOCAL`, effects
false), apply schema if needed then seed:

```bash
npm run migrate -- apply
npm run migrate -- validate
npm run seed
```

`npm run seed` is idempotent. It writes a coherent org/admin/responder/veterans
dataset (active QRF, consent, trusted contact, IN_APP notifications, resources,
settled case) and prints bearer credentials. Save the JSON somewhere gitignored
(e.g. `.local-secrets/seed-summary.json`) — do not commit bearers.

Example (credential from the seed summary):

```bash
curl -sS -H "authorization: Bearer $VETERAN_BEARER" \
  "$WORKER_BASE_URL/app/home"
```

Sessions expire (~24h); re-run `npm run seed` to mint fresh bearers.

## Rollback

Stop traffic to the bad Worker version and roll back to the previous
Wrangler version. Prefer a forward-fix migration over reversing schema.
See [deployment-rollback.md](deployment-rollback.md).
