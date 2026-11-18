# SUAS web app

React single-page app for SUAS v1. It talks to the `/api/v0` JSON API and is never served by the Fastify server (that server sends `script-src 'none'`). It is a separate package, not an npm workspace.

Stack: Vite, React, TypeScript (strict), React Router (data router), TanStack Query, Tailwind v4, openapi-typescript and openapi-fetch, Vitest and Testing Library. Day theme only.

## Run it

```sh
# 1. API (repo root): LOCAL mode on the default port 3000. Copy .env.example to a git-ignored .env,
#    add SUAS_SESSION_SECRET, then set SUAS_EMAIL_MODE=fake, SUAS_MODEL_INFERENCE_MODE=fake,
#    SUAS_CHAT_PUSH_MODE=local (chat WebSocket on SUAS_CHAT_LOCAL_WS_PORT, default 3001) and
#    SUAS_BROWSER_TENANT_ID (any UUID in LOCAL; new-email sign-up joins that tenant).
#    The Verify step also needs SUAS_VA_CONFIRMATION_MODE=fixture with SUAS_FINGERPRINT_KEY and
#    SUAS_FINGERPRINT_KEY_ID (see .env.example). e2e/config.ts `stackEnv` is a complete LOCAL fake set.
npm run migrate -- apply && npm run seed && npm run dev

# 2. Web (this folder): Vite on 5123, proxying /api to 127.0.0.1:${SUAS_API_PORT:-3000}
cd web && npm ci && npm run dev
```

`npm run dev:demo` at the repo root also serves the API on 3000, so the web app works against it with no extra settings; sign in as `demo@example.invalid` with code `123456`. The root [README](../README.md#run-it-locally) compares every launcher.

Sign-in codes in fake email mode come from `GET /api/v0/dev/last-challenge?destination=`.

Safety copy: `SUAS_SAFETY_COPY_MODE=approved` makes the API serve the released crisis copy (`GET /api/v0/immediate-resources` and the legacy `/app` pages); `placeholder_test_only`, the `.env.example` value and the only value TEST and CI may use, serves a labelled placeholder instead. The web app compiles its own crisis copy and does not read that endpoint, so it shows the same crisis copy in either mode.

| Script              | What it does                                                    |
| ------------------- | --------------------------------------------------------------- |
| `npm run dev`       | Vite dev server on http://127.0.0.1:5123                        |
| `npm run build`     | Typecheck, then production build to `dist/`                     |
| `npm run preview`   | Serve the production build on http://127.0.0.1:5123             |
| `npm run lint`      | ESLint (flat config, typescript-eslint, react-hooks)            |
| `npm run typecheck` | `tsc --noEmit`                                                  |
| `npm test`          | Vitest                                                          |
| `npm run gen:api`   | Regenerate `src/api/schema.d.ts` from `../docs/openapi/v0.json` |
| `npm run check`     | lint, typecheck, test, build (CI runs this)                     |
| `npm run test:e2e`  | Playwright suite in `e2e/` against a fresh LOCAL fake stack     |

### End-to-end tests

`npm run test:e2e` runs the Playwright suite in `e2e/` against the LOCAL fake stack. It builds its own API (3190), chat WebSocket (3191), Vite (5193) and `suas_local_e2e` database, reads no `.env`, and stops everything afterwards; CI runs it in four shards. It is separate from the staging suite at the repo root. Ports, database rules, layout, helpers and the UI coverage list are in [e2e/README.md](e2e/README.md).

Fonts are self-hosted through `@fontsource/public-sans` (600, 700) and `@fontsource/atkinson-hyperlegible` (400, 400 italic, 700), so the app makes no third-party requests and works under a strict CSP.

Optional env: `VITE_SUAS_ENV_LABEL` (shows the EnvChip, for example "Synthetic demo data"), `VITE_SUAS_API_BASE_URL` (API origin when not same-origin), `SUAS_API_PORT` (dev proxy target).

`/dev/components` is the component gallery. It exists in dev builds only.

## Layout

```
src/api/        client, token store, ApiError, query keys, idempotency, shared hooks
src/app/        router, route guards, layouts (chrome), mode store, paths, query client
src/components/ shared components, one file each (see the gallery)
src/features/   <area>/<Screen>Page.tsx: public, verify, request, support, serve, chat, licence, admin
src/lib/        small framework-free helpers (class names, single-flight, unique-by)
src/dev/        component gallery
src/test/       Vitest setup
e2e/            Playwright end-to-end suite (see e2e/README.md)
scripts/        gen-api.mjs, behind npm run gen:api
public/         icons, logos and the web manifest
```

### Adding or replacing a screen

Each route points at a lazy `features/<area>/<Screen>Page.tsx` with a default export. `/serve` is the one screen loaded up front: the case page navigates there with `flushSync`, which only renders at once when the route is already loaded. Replace that file and its siblings in the same folder; do not edit `app/router.tsx`. The chrome (crisis strip, header, footer, tab bar) comes from the layout route, so a page renders only its own content inside `<Page>`.

## API layer

- `api` (`src/api/client.ts`) is an openapi-fetch client typed by `ApiPaths`. Middleware:
  - adds `Authorization: Bearer <token>` from the sessionStorage token store;
  - adds `Idempotency-Key` (`crypto.randomUUID()`) to POST, PUT and PATCH unless the caller passes one;
  - turns every non-2xx response into a thrown `ApiError { status, code, message }` from the `{error:{code,message}}` envelope;
  - on 401 for a signed-in request: clears the token and goes to `/sign-in` (a wrong sign-in code is a 401 too and is left alone).
- Because errors throw, `const { data } = await api.GET(...)` is enough; use `isApiError` and `GATE_CODES` (`VERIFICATION_REQUIRED`, `COUNTY_REQUIRED`, `MFA_REQUIRED`, `FORBIDDEN`) to branch.
- `src/api/types.ts` has short names for the generated schemas (`Me`, `County`, `ServiceRequestListItem`, …). After the document changes, run `npm run gen:api`; the generated `schema.d.ts` is committed.
- Shared hooks: `useMe`, `useServiceRequests(ownership)`, `useInfiniteServiceRequests(ownership)`, `useServiceRequest(id)`, `useChatThreads()`, `useUpdateProfile()`, `useUpdateCounty()`, `useIdempotencyKey()`, the sign-in hooks in `auth.ts` (`useStartChallenge`, `useVerifyChallenge`, `useLogout`), and `useSessionToken()` and `useMfaElevated()` in `token-store.ts`. Queries stay idle while there is no session token.

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
