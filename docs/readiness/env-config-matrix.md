# Environment / configuration matrix

Pin source: `src/release/pins.ts`. Living values must match that file.

| Variable                           | LOCAL                                       | TEST            | STAGING                                    | PRODUCTION                               |
| ---------------------------------- | ------------------------------------------- | --------------- | ------------------------------------------ | ---------------------------------------- |
| `SUAS_ENV`                         | required                                    | required        | required                                   | rejected until SPEC-018 authorizes       |
| `SUAS_SPEC_VERSION`                | `0.9.0`                                     | `0.9.0`         | `0.9.0`                                    | `0.9.0` when authorized                  |
| `SUAS_RELEASE_MANIFEST`            | `RELEASE_MANIFEST-0.9.0.md`                 | same            | same                                       | same when authorized                     |
| `SUAS_ALLOW_REAL_EXTERNAL_EFFECTS` | false                                       | false           | false                                      | only if release authorizes               |
| `SUAS_JOB_QUEUE`                   | in-memory fake (default) or postgres-outbox | same            | ignored: Postgres outbox (D-022 pending)   | ignored: Postgres outbox (D-022 pending) |
| `DATABASE_QUERY_TIMEOUT_MS`        | optional, default 20000                     | same            | same                                       | same                                     |
| `SUAS_SUPPORT_SIGNAL_MODE`         | fixture/disabled                            | fixture         | fixture or released                        | released only                            |
| `SUAS_SAFETY_COPY_MODE`            | placeholder                                 | placeholder     | approved when reviewed                     | approved                                 |
| Migrations                         | apply/validate                              | apply in CI     | explicit apply in runbook                  | explicit; never implied                  |
| Session secret                     | required when auth on                       | generated in CI | secret store                               | secret store                             |
| `SUAS_EMAIL_MODE`                  | sink/fake                                   | fake            | `gmail_smtp` (R11.2)                       | rejected until SPEC-018 authorizes       |
| `SUAS_SMTP_USER`                   | unused                                      | unused          | relay secret, or env when sending directly | n/a                                      |
| `SUAS_SMTP_APP_PASSWORD`           | unused                                      | unused          | relay secret only (never Lambda env)       | n/a                                      |
| `SUAS_SMTP_RELAY_FUNCTION`         | unused                                      | unused          | the relay function name (CDK)              | n/a                                      |

`SUAS_JOB_QUEUE` accepts only `in-memory-fake` or `postgres-outbox`; any other value fails startup (ENVIRONMENT.md §5). `DATABASE_QUERY_TIMEOUT_MS` must be a positive integer; it is a client-side mechanism bound (ARCHITECTURE.md §13), not an SLO.

Email (suas-specs #75 R11.2, contributor proposal, not released): `gmail_smtp` sends through
`smtp.gmail.com:465` as one Google account with an app password. LOCAL and TEST reject it, like
`resend`. On AWS STAGING the API and job worker set only `SUAS_SMTP_RELAY_FUNCTION`; the relay
function outside the VPC reads `SUAS_SMTP_USER` and `SUAS_SMTP_APP_PASSWORD` from its Secrets
Manager secret. `SUAS_EMAIL_FROM` is not used with `gmail_smtp` (From is `SUAS_SMTP_USER`). The
`ses` mode is removed; `resend` stays available (D-004).

Source of truth: `src/config/schema.ts` + ENVIRONMENT.md + `src/release/pins.ts`.
