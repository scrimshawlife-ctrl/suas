# Decision packet — D-001 / D-005 staging & hosting

**Status:** DECIDED vendor topology; shared-account host superseded pending independently owned SUAS STAGING identity (2026-08-29) — GitHub + CF Worker + Neon
**Affects gates:** `OPERATIONS`, staging evidence for nearly all other gates  
**Runtime tip when written:** post-`#108` D-022 outbox; formal `SUAS_ENV=STAGING` on workers.dev

## Exact questions

- Where does synthetic STAGING run (cloud account, region, network boundary)?
- Which identity/secret store and egress controls apply?
- Which managed Postgres hosts the synthetic STAGING data plane (D-005 for prod remains separate)?

## Released constraints

- PRODUCTION prohibited until SPEC-018 authorizes it.
- LOCAL/TEST/STAGING must not point at production data resources.
- Real provider effects remain false outside authorized production (`SUAS_ALLOW_REAL_EXTERNAL_EFFECTS=false`).
- Durable job product is D-022 Postgres outbox (`DECIDED`). `STAGING` uses `postgres-outbox`; `PRODUCTION` remains prohibited until SPEC-018.

## Recommended option (STAGING topology)

**GitHub + Cloudflare Workers + Neon (synthetic only).**

| Piece                      | Vendor / surface                                                       | Notes                                                   |
| -------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------- |
| Source, CI, Pages poster   | GitHub (`scrimshawlife-ctrl/suas`)                                     | `verify` + `pages` workflows; static `docs/` on Pages   |
| `/app` + `/api/v0` compute | Cloudflare Worker (`wrangler.jsonc`, `src/worker.ts`)                  | Already implemented (#90); `nodejs_compat` + Hyperdrive |
| Synthetic Postgres         | Neon (pooled URL → Hyperdrive; unpooled URL → local `npm run migrate`) | Never production data; never commit connection strings  |
| Secrets                    | Wrangler secrets + GitHub Environment secrets for deploy               | `SUAS_SESSION_SECRET`; CF API token for publish         |
| Jobs                       | Postgres outbox (`job_outbox`, D-022)                                  | Drain with `npm run jobs:work` (Node against unpooled)  |

This matches the shipped runbook [cloudflare-workers.md](../runbooks/cloudflare-workers.md): Pages stays the poster; the Worker is the only API host; do not add Fly or a second orchestrator.

### Why not alternatives

- **GitHub Pages alone** — static; cannot run Fastify/`pg`.
- **Cloudflare Containers** — unnecessary now that the Fastify app already runs on Workers (#90).
- **Workers without Hyperdrive** — request path must not take a raw `DATABASE_URL` secret for pooled access; Hyperdrive is the released Worker binding.

## Interim vs formal STAGING

1. **Interim shared synthetic (superseded):** Worker ran as `SUAS_ENV=LOCAL` with in-memory jobs before D-022.
2. **Shared-account Workers host (retired):** the prior `suas` Worker endpoint shared another product's Cloudflare workers.dev identity. It is not an acceptable SUAS isolation boundary and cannot be used for acceptance, OAuth callback registration, or new evidence.
3. **Required synthetic STAGING replacement:** a `suas` Worker, SUAS-only GitHub Environment, SUAS-only Cloudflare account/subdomain or custom hostname, SUAS Hyperdrive binding, and synthetic SUAS database. Effects remain false. Not PRODUCTION.

## Required owner action

1. Confirm the independently owned SUAS Cloudflare account and its workers.dev subdomain or custom STAGING hostname.
2. Confirm the synthetic-only Neon project and create its Hyperdrive config in the SUAS Cloudflare account; place id in an **uncommitted** override or CF dashboard binding — not a password in git.
3. Create GitHub Environment `suas-synthetic-staging`, containing only SUAS synthetic secrets and `SUAS_E2E_BASE_URL`.
4. Authorize `npx wrangler secret put SUAS_SESSION_SECRET` and the first independent synthetic-STAGING deploy. This packet alone is not a deploy order.
5. Keep D-001/D-005 **production** cloud/DB decisions open until SPEC-018 production authorization.

## Work completed independently

- Config fail-closed for PRODUCTION without authorization.
- Health/provenance surfaces; migrate CLI; OpenAPI; decision packets for D-022 and SLO/RTO.
- Cloudflare Worker host for Fastify `/app` + `/api/v0` (#90) with Hyperdrive binding, Worker env validation, and runbook.
- Cases queue `cursor`/`limit` over `/api/v0` (#88).
