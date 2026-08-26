# Deployment and rollback runbook (synthetic / non-production)

## Preconditions

- `SUAS_ENV` is `LOCAL`, `TEST`, or (when authorized) `STAGING` — never enable `PRODUCTION` to “try deploy”.
- Spec pin `SUAS_SPEC_VERSION=0.2.0` and matching release manifest.
- `SUAS_ALLOW_REAL_EXTERNAL_EFFECTS=false`.
- Durable job product still D-022: STAGING process start fails closed until decided.

## Deploy (application)

1. Build: `npm ci && npm run build`
2. Migrate explicitly (not implied by app start in production policy):  
   `SUAS_MIGRATIONS_MODE=apply npm run migrate -- apply`
3. Validate: `npm run migrate -- validate` / `status`
4. Start with stamped provenance: set `SUAS_BUILD_COMMIT`, `SUAS_BUILD_TIMESTAMP`
5. Probe: `GET /api/v0/health` → `status=ok`; admin build-info only under MFA SUAS-admin

## Rollback

1. Stop new traffic to the bad revision.
2. Redeploy previous known-good image/commit.
3. Schema: **prefer forward-repair**. Do not silently reverse migrations that may have written data. If a destructive reverse is required, treat it as an incident with backup restore (see incident runbook + D-024).
4. Confirm health + OpenAPI drift check on the rolled-back revision’s CI green run.

## Explicit non-goals

- No automatic production cutover.
- No real veteran data migration.
