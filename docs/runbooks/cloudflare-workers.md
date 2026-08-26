# Cloudflare Workers compute

This Worker hosts the existing Fastify `/app` and `/api/v0` surfaces. GitHub
Pages `docs/` stays the static poster. This runbook does not authorize
PRODUCTION, SPEC-018, or a live deploy.

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

## Rollback

Stop traffic to the bad Worker version and roll back to the previous
Wrangler version. Prefer a forward-fix migration over reversing schema.
See [deployment-rollback.md](deployment-rollback.md).
