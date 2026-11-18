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

The six plan §10 end-to-end scenarios sit at the root, `01-` to `06-` (a request through the Intake Assistant, accept and chat, widening, the RED alert, catalog publish, crisis). Playwright walks `e2e/` depth first, sorting each folder's files and subfolders together by name, and a digit sorts before every letter, so these run before the specs in every folder. `03-widening` relies on that, because it expects the boards of other counties to be empty. A root spec that sorts before `03-` (for example `00-setup.spec.ts`), or a folder that does (`00-triage/`), would run first and break it as an apparent product bug. `src/e2e-order.test.ts` (in `npm run check`) reads Playwright's own `--list` order and fails unless only `01-` and `02-` run before `03-widening`; a shard runs a contiguous slice of that order on its own database, so it holds under `--shard` too.

Every other spec lives in a folder, one folder per area. Specs in a folder are numbered in the order a reader should take them (`01-`, `02-`, ...); `multi/` and `time/` use their plan IDs instead, and `cross/` and `decided/` are unnumbered.

- `auth/`: landing, sign-in, welcome, gates and sign-out, guards and sign-out, session end
- `verify/`: the VA confirmation form, the licence fallback
- `request/`: the Intake Assistant, the plain form, request status, edit, cancel, deep links, home and list, then the early gap fixes (edit before accept, edit after a stale accept, the plain form under the assistant, a cancelled request leaving the board)
- `serve/`: the board, case commands, alerts, wrap-up, release and expiry, Back at once after a reload
- `chat/`: conversation, errors, the offline outbox, thread paging
- `support/`: resources, Check-In, trusted contacts, invitations, notifications, consents, crisis, deep links, Check-In resume
- `admin/`: MFA, overview, resource extraction, draft review, non-admins, consent templates, consent template v2
- `multi/`: two or more people at once, named by plan ID (`m1`, `m3`, ...)
- `time/`: time-driven flows (`t1` to `t7`)
- `cross/`: accessibility of the main screens and at several viewports, 320 px reflow, a phone run through a request and crisis, double-click safety, browser history, list paging
- `decided/`: Round 12 decisions (R12.1 to R12.4)

Each folder may have a helper file named after it (`auth/auth.ts`, `request/request.ts`, `serve/serve.ts`, `support/support.ts`, `admin/admin.ts`, `chat/chat.ts`, `multi/multi.ts`, `time/time.ts`). Some specs overlap others (for example `06-crisis` and `support/07-crisis`); they stay until folding them is agreed, because no test is deleted without a human's sign-off.

## Shared helpers

- `fixtures.ts`: the suite's `test` and `expect`. Specs import them from here, not from `@playwright/test`. Every browser context a test opens is watched (`watch.ts`) for console errors, page errors, failed requests and 5xx. A test that provokes one on purpose adds a pattern to `allow`. Every `/api/v0` response is checked by `contract.ts`.
- `contract.ts`: each `/api/v0` response must use a status that `docs/openapi/v0.json` documents for its operation and must match its schema. Each response is also logged to `e2e-results/coverage/*.jsonl`.
- `people.ts`: the one way to make a test user. `newVeteran` signs up a Veteran and passes the ID check (unless `verified: false`), ending on `/home`; `newHelper` signs up a helper in Serve mode, ending on `/serve`. Both live in Santa Clara unless the test names a `county`, and each gets its own browser context.
- `helpers.ts`: browser contexts and sign-up (`newPerson`, `signUp`, `passIdCheck`), sign-in codes (`readSignInCode`), scripted model turns (`scriptModel`), `requestHelp`, database access (`withDb`), the job worker (`runJobWorkerOnce`), the page clock (`runClock`) and screenshots (`shoot`).
- The browser does everything a person can do. The API and database are used only for what a person cannot do: reading the fake sign-in code, scripting the fake model, moving time, and seeding lists longer than one page.

## Time skips

A test moves time by moving one stored timestamp into the past in the e2e database, then runs one job-worker pass (`runJobWorkerOnce`, which is `src/cli/job-worker.ts --once`) so the sweeps act on it. Every time skip lives in `time/time.ts`: request `submitted_at`, chat `released_at`, consent `expires_at`, session `expires_at` and `last_seen_at`, `mfa_elevated_at`, and Check-In `started_at`. For timers in the page, `runClock` advances a paused Playwright clock.

## UI coverage

`coverage/ui-less.json` lists the `/api/v0` operations that have no web caller on purpose, each with a `reason` and a spec `ref`. The root script `npm run ui:coverage` (`scripts/ui-coverage.ts`, run from the repo root) compares every operation in `docs/openapi/v0.json` with the web callers (`api.METHOD('/api/v0/...')` in `web/src`), the logged e2e hits and this list. It prints a table and exits 0; `-- --check` fails on any gap. CI appends each shard's table to the job summary. When you add an operation that the web app does not call, add it to `ui-less.json` with its reason.
