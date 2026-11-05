# V1 baseline rebuild

The v1 schema ships as a rewritten baseline. There is no in-place upgrade from an earlier schema, and there are no down migrations. `src/db/migrator.ts` still refuses a recorded checksum that does not match the migration file.

An existing database that is not a disposable synthetic database cannot be upgraded in place. Do not reset it. Do not point a reset at a shared, staging, or production database.

`npm run migrate -- reset` drops the `public` schema and applies the baseline only when every gate below passes:

- `SUAS_ENV` is not `PRODUCTION`
- `DATABASE_URL` names a database
- that database name, or the full URL, is listed in `SUAS_MIGRATION_RESET_ALLOWLIST`
- the database name contains `SUAS_MIGRATION_RESET_SYNTHETIC_MARKER`

Anything else is refused, and the schema is left unchanged. Leave both reset variables unset except when the target is an explicitly named synthetic disposable database, such as the migration-harness database `suas_migrations_test`. The marker is a substring you choose that appears only in those disposable names.

This command is not a startup mode. `SUAS_MIGRATIONS_MODE` stays `off`, `validate`, or `apply`, and `apply` still refuses checksum drift.
