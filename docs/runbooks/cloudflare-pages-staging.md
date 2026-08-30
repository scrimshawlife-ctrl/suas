# Cloudflare Pages synthetic STAGING readiness

## Decision

**Decision: do not deploy SUAS to Cloudflare Pages.** The current application is a
Fastify server running through Cloudflare Workers' Node HTTP bridge
(`src/worker.ts`), with Hyperdrive/Postgres persistence and an outbox worker. Its
build output is server-side `dist/`, not a static site directory with an
`index.html`. A Pages Functions migration would be an architectural rewrite and
would incorrectly put persistence and durable-job concerns on a request path.

The supported synthetic STAGING topology remains the existing Cloudflare Worker
for `/app` and `/api/v0`. GitHub Pages `docs/` remains a static poster only. A
future Pages frontend is possible only as a separately approved static client
that calls an explicitly authorized synthetic API, with an API/CORS/auth design
review first.

## Observed implementation facts

| Item                          | Value                                  | Evidence                             |
| ----------------------------- | -------------------------------------- | ------------------------------------ |
| Framework                     | Fastify 5, TypeScript, Node 22         | `package.json`                       |
| Package manager               | npm with committed `package-lock.json` | `package.json`, `package-lock.json`  |
| Build command                 | `npm run build`                        | `package.json`                       |
| Build output                  | `dist/` server JavaScript              | `README.md`, `package.json`          |
| Compute host                  | Cloudflare Worker                      | `src/worker.ts`, `wrangler.jsonc`    |
| Data plane                    | Hyperdrive to synthetic Postgres       | `wrangler.jsonc`, `src/app.ts`       |
| Static Pages output directory | **NOT_COMPUTABLE: none exists**        | no static app build or `index.html`  |
| SPA fallback                  | not applicable                         | server routes are handled by Fastify |

## Pages project plan, blocked pending an approved static frontend

The intended future Pages project name is `suas-staging`, but it must not be
created, deployed, or connected to DNS until an authorized owner supplies
Cloudflare credentials and explicitly approves a static frontend boundary.

| Dashboard field  | Future value                     | Current status               |
| ---------------- | -------------------------------- | ---------------------------- |
| Framework preset | None / static export             | blocked: no export exists    |
| Root directory   | repository root                  | inferred                     |
| Build command    | approved frontend build command  | NOT_COMPUTABLE               |
| Output directory | verified static output directory | NOT_COMPUTABLE               |
| Node version     | 22                               | observed                     |
| Preview URL      | Cloudflare-generated preview URL | unknown until owner creation |
| Custom domain    | none                             | not authorized               |

Do not point a Pages preview at a pilot or production API. Do not publish
secrets through `VITE_*`, `NEXT_PUBLIC_*`, `PUBLIC_*`, or similar prefixes.

## Synthetic STAGING safety contract

`npm run staging:contract` validates the committed Worker config without making
network calls. It requires `SUAS_ENV=STAGING`, effects disabled, migration
validation, sink communications, fake/manual adapters, fixture-only support
signals, placeholder safety copy, and disabled sensitive reporting. It rejects
public-prefixed secret-like names, configured Resend/service-role credentials,
and endpoint values marked pilot/prod/production.

### Environment classification

| Variable family                         | Class                    | Owner / storage                       | Notes                                            |
| --------------------------------------- | ------------------------ | ------------------------------------- | ------------------------------------------------ |
| `SUAS_ENV`, safe-mode flags, provenance | non-secret server config | Cloudflare Worker configuration owner | STAGING only                                     |
| `HYPERDRIVE` binding                    | server binding           | Cloudflare Worker configuration owner | synthetic database only                          |
| `SUAS_SESSION_SECRET`                   | server secret            | Wrangler secret store                 | never `vars`, browser, or git                    |
| `DATABASE_URL`                          | Node-only server secret  | approved local/CI secret store        | never Pages or Worker browser code               |
| `RESEND_API_KEY`, provider credentials  | server secrets           | approved secret store                 | absent in synthetic STAGING; email/SMS are sinks |
| `SUAS_E2E_*_BEARER`                     | CI secret                | GitHub Actions secrets                | synthetic sessions only, never logged            |

## Resend and browser safety

The Worker STAGING surface uses Resend only for released browser authentication
to owner-approved enrolled test identities. GitHub Pages remains static and
does not hold or send provider credentials.
If a later authorized server-side mode uses Resend, the API key belongs in the
Worker secret store, not `vars` or any public prefix. A test email address is
not configured in this repository and must be supplied only through an approved
server-side secret/config path. No client-side email provider initialization is
permitted.

## Headers and security posture

Fastify currently adds a request correlation header and redacts authorization,
cookie, and idempotency headers from logs (`src/http/server.ts`). No Pages
headers file is added because there is no Pages static artifact. A future static
frontend must provide a separate, reviewed `_headers` policy that is compatible
with its actual assets and API origin.

## CI and verification

The PR workflow uses Node 22, `npm ci`, format, lint, typecheck, build, tests,
OpenAPI drift, migration harness, and provenance. It now also runs
`npm run staging:contract`. Pages output checks are intentionally omitted: a
static output directory does not exist, so claiming one would be a false gate.

## Operator evidence checklist

Before any owner-authorized future Pages deploy, record:

1. commit SHA and `npm ci` result;
2. `npm run staging:contract`, lint, typecheck, tests, and build results;
3. verified static output directory and artifact manifest, if a frontend exists;
4. preview URL returned by Cloudflare, visibly marked synthetic STAGING;
5. browser smoke evidence with only synthetic sessions and no secrets;
6. authorization record for project creation, deploy, domain/DNS, and API origin.

## Commands

Current safe local verification:

```bash
npm ci
npm run staging:contract
npm run lint
npm run typecheck
npm test
npm run build
```

No Pages deployment was authorized and no verified Pages output directory
exists. If a later owner approves the separate static frontend and its output
has been verified, the required Pages command is:

```bash
npx wrangler pages deploy <verified-output-directory> --project-name suas-staging
```

This command is not appropriate for the current Fastify Worker runtime.
