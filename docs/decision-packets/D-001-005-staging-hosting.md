# Decision packet — D-001 / D-005 staging & hosting

**Status:** OWNER_DECISION_REQUIRED (recommendation pinned; account/secrets still owner)  
**Affects gates:** `OPERATIONS`, staging evidence for nearly all other gates  
**Runtime tip when written:** post-`#90` Worker compute + `#88` cases cursor

## Exact questions

- Where does synthetic STAGING run (cloud account, region, network boundary)?
- Which identity/secret store and egress controls apply?
- Which managed Postgres hosts the synthetic STAGING data plane (D-005 for prod remains separate)?

## Released constraints

- PRODUCTION prohibited until SPEC-018 authorizes it.
- LOCAL/TEST/STAGING must not point at production data resources.
- Real provider effects remain false outside authorized production (`SUAS_ALLOW_REAL_EXTERNAL_EFFECTS=false`).
- Durable job product remains D-022: `STAGING` / `PRODUCTION` fail closed on the in-memory queue (`src/jobs/factory.ts`). Shared HTTP soak can use `SUAS_ENV=LOCAL` on the Worker until D-022 lands; do not relabel that as formal STAGING class readiness.

## Recommended option (STAGING topology)

**GitHub + Cloudflare Workers + Neon (synthetic only).**

| Piece                      | Vendor / surface                                                       | Notes                                                   |
| -------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------- |
| Source, CI, Pages poster   | GitHub (`scrimshawlife-ctrl/suas`)                                     | `verify` + `pages` workflows; static `docs/` on Pages   |
| `/app` + `/api/v0` compute | Cloudflare Worker (`wrangler.jsonc`, `src/worker.ts`)                  | Already implemented (#90); `nodejs_compat` + Hyperdrive |
| Synthetic Postgres         | Neon (pooled URL → Hyperdrive; unpooled URL → local `npm run migrate`) | Never production data; never commit connection strings  |
| Secrets                    | Wrangler secrets + GitHub Environment secrets for deploy               | `SUAS_SESSION_SECRET`; CF API token for publish         |
| Jobs                       | In-memory fake only while `SUAS_ENV=LOCAL`                             | Formal `STAGING` class waits on D-022                   |

This matches the shipped runbook [cloudflare-workers.md](../runbooks/cloudflare-workers.md): Pages stays the poster; the Worker is the only API host; do not add Fly or a second orchestrator.

### Why not alternatives

- **GitHub Pages alone** — static; cannot run Fastify/`pg`.
- **Cloudflare Containers** — unnecessary now that the Fastify app already runs on Workers (#90).
- **Workers without Hyperdrive** — request path must not take a raw `DATABASE_URL` secret for pooled access; Hyperdrive is the released Worker binding.

## Interim vs formal STAGING

1. **Interim shared synthetic (allowed now):** deploy Worker with `SUAS_ENV=LOCAL`, fixture/fake adapters, synthetic Neon DB. Use for `/app` + `/api/v0` soak and Pages-linked demos. Does **not** close OPERATIONS as formal STAGING evidence alone.
2. **Formal STAGING class:** after owner decides D-022 durable queue, set `SUAS_ENV=STAGING` on a dedicated Worker env + Neon branch, keep effects false, re-run soak under STAGING.

## Required owner action

1. Confirm Cloudflare account (which org/account owns `suas` Worker).
2. Confirm Neon project (synthetic-only) and create Hyperdrive config; place id in an **uncommitted** override or CF dashboard binding — not a password in git.
3. Authorize `npx wrangler secret put SUAS_SESSION_SECRET` (and GH Environment secrets if CI deploy is enabled).
4. Explicitly authorize first shared deploy (interim LOCAL Worker) — this packet alone is not a deploy order.
5. Keep D-001/D-005 **production** cloud/DB decisions open until SPEC-018 production authorization.

## Work completed independently

- Config fail-closed for PRODUCTION without authorization.
- Health/provenance surfaces; migrate CLI; OpenAPI; decision packets for D-022 and SLO/RTO.
- Cloudflare Worker host for Fastify `/app` + `/api/v0` (#90) with Hyperdrive binding, Worker env validation, and runbook.
- Cases queue `cursor`/`limit` over `/api/v0` (#88).
