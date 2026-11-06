# V1 baseline rebuild

The v1 schema ships as a rewritten baseline. There is no in-place upgrade from an earlier schema, and there are no down migrations. `src/db/migrator.ts` still refuses a recorded checksum that does not match the migration file.

An existing database that is not a disposable synthetic database cannot be upgraded in place. Do not reset it. Do not point a reset at a shared, staging, or production database.

`npm run migrate -- reset` drops the `public` schema and applies the baseline only when every gate below passes:

- `SUAS_ENV` is `LOCAL` or `TEST`. `STAGING` and `PRODUCTION` are refused. A marker substring does not make a staging database disposable.
- `DATABASE_URL` is a `postgres:` or `postgresql:` URL that names the user, the password, the host, the port, and the database. It has no fragment and no query string. The same shape is required when the allowlist entry is a full URL. The database name is on `SUAS_MIGRATION_RESET_ALLOWLIST`, or that full URL is.
- the host and database name do not contain a production-data marker (`prod`, `production`, `live`)
- the database name contains `SUAS_MIGRATION_RESET_SYNTHETIC_MARKER`
- `DATABASE_URL`, and any set `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, or `PGDATABASE`, agree with that URL. An unset value is not a conflict.
- these variables are unset: `PGOPTIONS`, `PGSSLMODE`, `PGSSLNEGOTIATION`, `PGSSLCERT`, `PGSSLKEY`, `PGSSLROOTCERT`, `PGSSLCRL`, `PGSSLCOMPRESSION`, `PGCLIENT_ENCODING`, `PGREPLICATION`, `PGBINARY`, `PGPASSFILE`, `PGHOSTADDR`, `PGSERVICE`, `PGSERVICEFILE`, `PGTARGETSESSIONATTRS`, and `NODE_PG_FORCE_NATIVE`. The pinned pure-JS `pg` client applies the first group when the URL does not pin them. The pure-JS client does not read `PGHOSTADDR`, `PGSERVICE`, `PGSERVICEFILE`, or `PGTARGETSESSIONATTRS`; libpq does when `NODE_PG_FORCE_NATIVE` selects the native client. `PGAPPNAME` is read as `application_name` and does not select a server, so it is not a gate. `PGCONNECT_TIMEOUT` only bounds how long connect waits.
- one checked-out client is that same target, and it is released only after the rebuild. Before any schema statement it reads `current_database()`, `host(inet_server_addr())`, and `inet_server_port()`. The authorized host has to be an IP literal. A hostname is ambiguous, and a null server address (a local socket, for example) is an unsupported topology. The live address, port, and database have to equal the authorized URL. That same client then drops `public`, creates it, and applies the baseline.

Anything else is refused, and the schema is left unchanged. Leave both reset variables unset except when the target is an explicitly named synthetic disposable database, such as the migration-harness database `suas_migrations_test`. The marker is a substring you choose that appears only in those disposable names. It does not by itself authorize a reset.

This command is not a startup mode. `SUAS_MIGRATIONS_MODE` stays `off`, `validate`, or `apply`, and `apply` still refuses checksum drift.
