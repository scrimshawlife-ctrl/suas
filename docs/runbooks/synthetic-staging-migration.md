# Synthetic STAGING migration runbook

## Scope and authority

This runbook applies only to the independently owned synthetic SUAS STAGING
database. It does not authorize production operation, a pilot, real veteran data,
real provider effects, or a Worker deployment by itself.

The migration target for the current D-035 evidence build is schema version 14,
with `0014_va_sandbox_oauth_evidence.sql` pending on the previously deployed
schema version 13 database. Migration 0014 is additive: it creates the normalized
VA sandbox OAuth transaction and veteran-verification tables and enums. It does
not store authorization codes, access tokens, ID tokens, raw VA payloads, or VA
identifiers.

An attributable owner must approve the exact database target before execution.
The current repository does not contain a database credential or connection
string. The workflow therefore requires the GitHub Environment secret
`STAGING_DATABASE_URL`, supplied only by the synthetic STAGING owner.

## Preconditions

1. Confirm the workflow is running from the intended commit on `main`.
2. Confirm the target is the dedicated synthetic STAGING database, not a shared,
   pilot, live, or production database.
3. Confirm the owner has supplied `STAGING_DATABASE_URL` as an unpooled Node/CLI
   connection URL in the protected `suas-synthetic-staging` GitHub Environment.
4. Confirm the target has no real veteran data, provider credentials, or external
   effects enabled. The workflow pins `SUAS_ENV=STAGING` and
   `SUAS_ALLOW_REAL_EXTERNAL_EFFECTS=false`.
5. Confirm the migration plan reports no drifted or orphaned migrations. A
   non-empty drift/orphan result is a hard stop.

## Execution

1. Open GitHub Actions and dispatch **staging-migrate** with `confirm=migrate`.
2. Complete the protected environment approval, if configured.
3. Review the pre-apply status output. For the known blocker it should show
   `0014_va_sandbox_oauth_evidence.sql` as the only pending migration.
4. Allow **Apply committed migrations** to run. The migration CLI takes the
   advisory lock and applies each migration plus its bookkeeping row in one
   transaction.
5. Require **Validate migration state after apply** to pass with schema version
   14 and no pending, drifted, or orphaned migrations.
6. Manually dispatch **worker-deploy** with `confirm=deploy` so the Worker runs
   the current build against the now-compatible schema. Its runtime remains
   `SUAS_MIGRATIONS_MODE=validate`.
7. Manually dispatch **staging-acceptance** for the public smoke path. Include
   authenticated or elevated-admin coverage only when the synthetic sessions are
   fresh and the relevant owner has approved that evidence scope.

## Failure and rollback posture

- If migration 0014 fails before commit, the transaction rolls back and the
  database remains at its prior migration state.
- Do not edit or delete an applied migration file, and do not invent a down
  migration. Any post-apply correction must be a new, reviewed forward-fix
  migration.
- Abort on any production marker, unexpected migration history, schema divergence,
  external effect, real data, credential exposure, or target-identity mismatch.
- Preserve the command output and workflow URL as sanitized evidence. Never record
  the database URL, credentials, authorization headers, or bearer values.

## Completion evidence

Record the migration workflow URL, commit SHA, before/after schema versions, the
applied migration names, and the subsequent staging acceptance result. Keep
`PRODUCTION_LAUNCH=blocked` and D-035 at its existing decision status.
