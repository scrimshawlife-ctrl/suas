# SUAS web app

React single-page app for SUAS v1. It talks to the `/api/v0` JSON API and is never served by the Fastify server (that server sends `script-src 'none'`). It is a separate package, not an npm workspace.

Stack: Vite, React, TypeScript (strict), React Router (data router), TanStack Query, Tailwind v4, openapi-typescript and openapi-fetch, Vitest and Testing Library. Day theme only.

## Run it

```sh
# 1. API (repo root): LOCAL mode, port 3120. Copy .env.example to a git-ignored .env, then set
#    SUAS_ENV=LOCAL, SUAS_HTTP_PORT=3120, SUAS_EMAIL_MODE=fake, SUAS_ID_VERIFICATION_MODE=fake,
#    SUAS_MODEL_INFERENCE_MODE=fake, SUAS_CHAT_PUSH_MODE=local, SUAS_CHAT_LOCAL_WS_PORT=3121,
#    SUAS_SAFETY_COPY_MODE=approved, DATABASE_SSL_MODE=disable and a local DATABASE_URL.
#    New-email sign-up also needs SUAS_BROWSER_TENANT_ID set to a tenant UUID (any UUID in LOCAL).
npm run migrate -- apply && npm run seed && npm run dev

# 2. Web (this folder): Vite on 5123, proxying /api to 127.0.0.1:${SUAS_API_PORT:-3120}
cd web && npm ci && npm run dev
```

Sign-in codes in fake email mode come from `GET /api/v0/dev/last-challenge?destination=`.

| Script              | What it does                                                    |
| ------------------- | --------------------------------------------------------------- |
| `npm run dev`       | Vite dev server on http://127.0.0.1:5123                        |
| `npm run build`     | Typecheck, then production build to `dist/`                     |
| `npm run lint`      | ESLint (flat config, typescript-eslint, react-hooks)            |
| `npm run typecheck` | `tsc --noEmit`                                                  |
| `npm test`          | Vitest                                                          |
| `npm run gen:api`   | Regenerate `src/api/schema.d.ts` from `../docs/openapi/v0.json` |
| `npm run check`     | lint, typecheck, test, build (CI runs this)                     |

### End-to-end tests

`npm run test:e2e` runs the Playwright suite in `e2e/` against the LOCAL fake stack. CI runs it in the `web-e2e` job of `.github/workflows/verify.yml` with `SUAS_E2E_SAFETY_COPY_MODE=placeholder_test_only`; it is separate from the staging suite at the repo root. It needs a Postgres on localhost:5432 (locally the Docker container `suas-postgres17-local`; `SUAS_E2E_DB_HOST_URL` points elsewhere) and Chromium (`npx playwright install chromium` once). One command builds everything from scratch: it drops and recreates the `suas_local_e2e` database, applies migrations, seeds it, starts the API on 3190 (chat WebSocket on 3191) with a random per-run session secret, and starts Vite on 5193, then stops both afterwards. No `.env` is read. It walks the plan §10 scenarios (request, accept and chat, widening, RED alert, catalog, crisis) through the real UI, including a trusted contact accepting an invite on the Invitations screen; the API is used only to read the fake sign-in code, script the fake model, read back server state after a UI step, and seed lists longer than one page so the paging ("Show more") tests have something to page through. Time-skipping updates `submitted_at` in the e2e database and runs `src/cli/job-worker.ts --once`. Set `SUAS_E2E_SHOTS_DIR` to also save 1280 px and 390 px review screenshots; `SUAS_E2E_API_PORT`, `SUAS_E2E_WS_PORT`, `SUAS_E2E_WEB_PORT` and `SUAS_E2E_DB_NAME` (must match `suas_local_*`) move the stack.

Fonts are self-hosted through `@fontsource/public-sans` (600, 700) and `@fontsource/atkinson-hyperlegible` (400, 400 italic, 700), so the app makes no third-party requests and works under a strict CSP.

Optional env: `VITE_SUAS_ENV_LABEL` (shows the EnvChip, for example "Synthetic demo data"), `VITE_SUAS_API_BASE_URL` (API origin when not same-origin), `SUAS_API_PORT` (dev proxy target).

`/dev/components` is the component gallery. It exists in dev builds only.

## Layout

```
src/api/        client, token store, ApiError, query keys, useMe, auth hooks
src/app/        router, route guards, layouts (chrome), mode store, paths
src/components/ shared components, one file each (see the gallery)
src/features/   <area>/<Screen>Page.tsx: public, request, support, serve, chat, admin
src/dev/        component gallery
```

### Adding or replacing a screen

Each route points at a lazy `features/<area>/<Screen>Page.tsx` with a default export. Replace that file and its siblings in the same folder; do not edit `app/router.tsx`. The chrome (crisis strip, header, footer, tab bar) comes from the layout route, so a page renders only its own content inside `<Page>`.

## API layer

- `api` (`src/api/client.ts`) is an openapi-fetch client typed by `ApiPaths`. Middleware:
  - adds `Authorization: Bearer <token>` from the sessionStorage token store;
  - adds `Idempotency-Key` (`crypto.randomUUID()`) to POST, PUT and PATCH unless the caller passes one;
  - turns every non-2xx response into a thrown `ApiError { status, code, message }` from the `{error:{code,message}}` envelope;
  - on 401 for a signed-in request: clears the token and goes to `/sign-in` (a wrong sign-in code is a 401 too and is left alone).
- Because errors throw, `const { data } = await api.GET(...)` is enough; use `isApiError` and `GATE_CODES` (`VERIFICATION_REQUIRED`, `COUNTY_REQUIRED`, `MFA_REQUIRED`, `FORBIDDEN`) to branch.
- `src/api/types.ts` has short names for the generated schemas (`Me`, `County`, `ServiceRequestListItem`, …). After the document changes, run `npm run gen:api`; the generated `schema.d.ts` is committed.
- Shared hooks: `useMe`, `useServiceRequests(ownership)`, `useServiceRequest(id)`, `useChatThreads()`, `useUpdateProfile()`, `useUpdateCounty()`, and the sign-in hooks in `auth.ts`. Queries stay idle while there is no session token.

### Writes and idempotency

Every POST, PUT and PATCH carries an `Idempotency-Key`. If the caller passes none, the client adds a random one per request, which only protects a single request.

A screen that creates something must make one user action map to one key:

- Hold one key per submit with `useIdempotencyKey()` (`src/api/idempotency.ts`) and pass `headers: key.headers()` to `api.POST(...)`.
- Call `key.renew()` only after the action succeeded. A retry after an error or a dropped response reuses the same key, so the server replays instead of creating twice.
- Disable the submit button while the mutation is pending (`isPending`), so a double click cannot start a second action.

## Query keys

- Build every key with the factories in `src/api/keys.ts`. Never write a key array inline in a component.
- The first element is the resource name (`'me'`, `'service-requests'`). Lists are `[resource, 'list', filters]`, details `[resource, 'detail', id]`; nested resources put the parent id first (`['chat', serviceRequestId, 'messages']`).
- Use `resourceKeys('name')` for a new resource and add it to `queryKeys`.
- Invalidate by prefix: after creating a request, `invalidateQueries({ queryKey: queryKeys.serviceRequests.all })`; after a profile change, `queryKeys.me`.
- A mutation that changes who the person is (sign in, sign out) resets or invalidates `me`; sign out calls `queryClient.clear()`.
