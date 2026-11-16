# Deployment and rollback runbook (synthetic STAGING, AWS)

STAGING runs on the AWS CDK app in [`infra/`](../../infra/README.md). The preferred path is the manual
[`staging-deploy.yml`](../../.github/workflows/staging-deploy.yml) workflow: dispatch a `main` SHA, approve the
`suas-synthetic-staging` environment, and it deploys, migrates and smoke-tests in order (`infra/README.md`,
"Deploy workflow"). Rolling back is the same dispatch with an older SHA; it refuses when the deployed schema
is newer than that build expects. Until the AWS foundation in
[`aws-staging-bootstrap.md`](aws-staging-bootstrap.md) exists, deploys are run by hand with CDK as below
(R11.6, specs #75, released in 0.10.0). The Cloudflare Worker and the Neon
staging database are retired. This runbook does not authorize PRODUCTION, a pilot, real Veteran
data or real external effects, and a deploy is not SPEC-018 evidence.

## Preconditions

- The AWS account layout is decided and `CDK_DEFAULT_ACCOUNT` names it (never commit it).
  Until then, follow "Deploy order (not done yet)" in [`infra/README.md`](../../infra/README.md): nothing is deployed.
- The commit is on `main`, CI is green, and `cd infra && npm run check` passes locally.
- Spec pin `SUAS_SPEC_VERSION=0.10.0` and `SUAS_RELEASE_MANIFEST=RELEASE_MANIFEST-0.10.0.md` (`src/release/pins.ts`).
- `SUAS_ALLOW_REAL_EXTERNAL_EFFECTS=false`; synthetic data only (`ENVIRONMENT.md` §2).

## Deploy

From `infra/`, with credentials for the chosen account:

1. `npm ci` at the repository root and in `infra/`.
2. If the web app changed, build it for staging (see "Web" in `infra/README.md`).
3. `npx cdk diff` for the stacks you will deploy, and read it.
4. `npx cdk deploy Suas-Staging-Backend` (and `Suas-Staging-Web` for a web change).
   Do not pass `bedrockModelId`.
5. If the commit adds migrations, invoke the migrate function (`MigrateFunctionName` output) as
   in "Manual steps" of `infra/README.md`, and read `schema_version` and `applied_now`. Until it
   has run, the API fails closed at startup (`SUAS_MIGRATIONS_MODE=validate`).
6. Probe `GET https://<ApiUrl>/api/v0/health`: `status` is `ok`. Admin build-info is MFA SUAS-admin only.

## Rollback

The stacks publish no Lambda versions or aliases, so a rollback is a redeploy of the last
known-good commit.

1. Check out the last known-good commit and repeat "Deploy" steps 1–4 from it.
2. Schema: **prefer forward repair.** There are no down migrations (D-053). An older build refuses
   a newer schema at startup (`ENVIRONMENT.md` §9), so if the bad commit applied a migration, fix
   forward instead of rolling the code back. A destructive reverse is an incident: restore from an
   RDS snapshot (7-day automated backups) under the incident runbook and D-024.
3. Probe health as in "Deploy" step 6, and confirm CI is green for the rolled-back commit.

## Explicit non-goals

- No automatic production cutover.
- No real Veteran data migration.
