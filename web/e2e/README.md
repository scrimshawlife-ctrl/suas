# Web end-to-end suite

Playwright tests that drive the web app through a real browser against a LOCAL fake stack. They are separate from the staging acceptance suite at the repo root (`tests/e2e/`, `npm run test:e2e:staging`).

## Run it

```sh
npx playwright install chromium   # once
npm run test:e2e                  # in web/; all specs
npm run test:e2e -- serve/        # one folder, or a single spec path
```

It needs a PostgreSQL 17 server on `localhost:5432` with a `suas` / `suas` role that can create databases, for example the `suas-postgres17-local` container from the [root README](../../README.md#run-it-locally). No `.env` is read.

## How a run works

`playwright.e2e.config.ts` starts two web servers and stops both when the run ends:

1. `node --import tsx/esm e2e/stack.ts` drops and recreates the e2e database, runs `src/cli/migrate.ts apply` and `src/cli/seed-local.ts` from the repo root, then starts the API (`src/main.ts`). The environment comes from `stackEnv` in `config.ts`: `SUAS_ENV=LOCAL`, fake or sink adapters, no real external effects, and a session secret made fresh for each run that is never written to disk.
2. `npm run dev -- --port 5193` starts Vite with `SUAS_API_PORT` set to the e2e API port, so `/api` is proxied to it.

Tests run one at a time (`workers: 1`) because they share one database. CI runs the suite in four shards (`--shard=N/4`, the `web-e2e-shard` job in `.github/workflows/verify.yml`), each on its own runner and database.

## Ports, database and other settings

| Variable                    | Default                                 | What it does                                                       |
| --------------------------- | --------------------------------------- | ------------------------------------------------------------------ |
| `SUAS_E2E_API_PORT`         | `3190`                                  | API port                                                           |
| `SUAS_E2E_WS_PORT`          | `3191`                                  | Local chat WebSocket port                                          |
| `SUAS_E2E_WEB_PORT`         | `5193`                                  | Vite port                                                          |
| `SUAS_E2E_DB_NAME`          | `suas_local_e2e`                        | Database the run drops and recreates                               |
| `SUAS_E2E_DB_HOST_URL`      | `postgresql://suas:suas@localhost:5432` | Server that holds it: address only, no path or query               |
| `SUAS_E2E_SAFETY_COPY_MODE` | `approved`                              | CI sets `placeholder_test_only` (AGENTS.md)                        |
| `SUAS_E2E_SHOTS_DIR`        | unset                                   | If set, `shoot()` also saves 1280 px and 390 px review screenshots |

These defaults differ from the everyday ports (API 3000, Vite 5123), so the suite can run beside a dev server. Change the ports and database name to run a second checkout at the same time.

The database guard (`assertDisposableDatabase` in `config.ts`) runs whenever `config.ts` loads. It refuses any database name that does not match `suas_local_<name>` (lowercase letters, digits, `_`) and any host other than `localhost`, `127.0.0.1` or `::1`, because every run drops that database.

## Layout

- **Numbered root specs** (`01-request.spec.ts` to `16-*.spec.ts`, plus `list-paging` and `request-edit-stale`): the original plan §10 scenarios and early gap fixes. Some numbers repeat (two `15-`, two `16-`) and several overlap the folder suites; they stay as they are until a cleanup is agreed.
- **Folders**, one per area, numbered within the folder:
  - `auth/`: landing, sign-in, welcome, gates and sign-out, guards and sign-out, session end
  - `request/`: the Intake Assistant, the plain form, request status, edit, cancel, deep links, home and list
  - `serve/`: the board, case commands, alerts, wrap-up
  - `chat/`: conversation, errors, the offline outbox, thread paging
  - `support/`: resources, Check-In, trusted contacts, invitations, notifications, consents, crisis, deep links, check-in resume
  - `admin/`: MFA, overview, resource extraction, draft review, non-admins, consent templates
  - `multi/`: two or more people at once, named by plan ID (`m1`, `m3`, ...)
  - `time/`: time-driven flows (`t1` to `t7`)
  - `cross/`: accessibility at several viewports, double-click safety, browser history
  - `decided/`: Round 12 decisions (R12.1 to R12.4)
- Each folder may have a helper file named after it (`auth/auth.ts`, `request/request.ts`, `serve/serve.ts`, `support/support.ts`, `admin/admin.ts`, `chat/chat.ts`, `multi/multi.ts`, `time/time.ts`).

## Shared helpers

- `fixtures.ts`: the suite's `test` and `expect`. Specs import them from here, not from `@playwright/test`. Every browser context a test opens is watched (`watch.ts`) for console errors, page errors, failed requests and 5xx. A test that provokes one on purpose adds a pattern to `allow`. Every `/api/v0` response is checked by `contract.ts`.
- `contract.ts`: each `/api/v0` response must use a status that `docs/openapi/v0.json` documents for its operation and must match its schema. Each response is also logged to `e2e-results/coverage/*.jsonl`.
- `helpers.ts`: people with their own browser context (`newPerson`, `signUp`, `newVerifiedVeteran`), sign-in codes (`readSignInCode`), scripted model turns (`scriptModel`), `requestHelp`, database access (`withDb`), time skips (`ageRequest`, `runJobWorkerOnce`), the page clock (`runClock`) and screenshots (`shoot`).
- `people.ts`: the people a spec acts as, built through the UI — `newVeteran` (a verified Veteran already signed in) and `newHelper` (a second person in their own browser context) — so a spec names who is on screen instead of repeating the account setup.
- The browser does everything a person can do. The API and database are used only for what a person cannot do: reading the fake sign-in code, scripting the fake model, moving time, and seeding lists longer than one page.

## Time skips

A test moves time by moving one stored timestamp into the past in the e2e database, then runs one job-worker pass (`runJobWorkerOnce`, which is `src/cli/job-worker.ts --once`) so the sweeps act on it. The timestamps include request `submitted_at` (`helpers.ts`), chat `released_at`, consent `expires_at`, session `expires_at`, `last_seen_at` and `mfa_elevated_at` (`time/time.ts`), and Check-In `started_at` (also `time/time.ts`). For timers in the page, `runClock` advances a paused Playwright clock.

## UI coverage

`coverage/ui-less.json` lists the `/api/v0` operations that have no web caller on purpose, each with a `reason` and a spec `ref`. The root script `npm run ui:coverage` (`scripts/ui-coverage.ts`, run from the repo root) compares every operation in `docs/openapi/v0.json` with the web callers (`api.METHOD('/api/v0/...')` in `web/src`), the logged e2e hits and this list. It prints a table and exits 0; `-- --check` fails on any gap. CI appends each shard's table to the job summary. When you add an operation that the web app does not call, add it to `ui-less.json` with its reason.
