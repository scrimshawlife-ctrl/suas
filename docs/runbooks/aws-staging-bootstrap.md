# AWS foundation for the staging deploy workflow (synthetic STAGING)

One-time, human-run setup that lets [`staging-deploy.yml`](../../.github/workflows/staging-deploy.yml)
deploy the CDK app in [`infra/`](../../infra/README.md). Routine deploys then run from GitHub through OIDC;
nobody stores AWS keys in GitHub. This does not authorize PRODUCTION, a pilot, real Veteran data or real
external effects, and a deploy is not SPEC-018 evidence.

Run every command from a human administrator identity, never from GitHub. Pass `--region` every time:
the `zerostate` profile defaults to `us-west-1`, but the stacks live in `us-west-2` and `us-east-1`.
Never paste secret values into files, tickets or chat.

```sh
export AWS_PROFILE=zerostate ACCOUNT=<12-digit staging account id>
aws sts get-caller-identity --query Account --output text   # must print $ACCOUNT
```

## 0. Identity and quotas

1. Prefer an IAM Identity Center administrator over the account root user for everything below
   (`aws configure sso --profile zerostate`). Keep root for account recovery only.
2. New accounts start with 10 concurrent Lambda executions, all of which must stay unreserved. The
   pipeline's maintenance mode only ever reserves 0, so it works at that limit, but ask for headroom:
   `aws service-quotas request-service-quota-increase --region us-west-2 --service-code lambda --quota-code L-B99A9384 --desired-value 1000`.

## 1. CDK bootstrap (both regions)

The CloudFormation execution role gets `SuasCdkExecution`, not `AdministratorAccess`
([`infra/bootstrap/cfn-execution-policy.yaml`](../../infra/bootstrap/cfn-execution-policy.yaml)).

```sh
aws cloudformation deploy --region us-west-2 --stack-name Suas-Cdk-Execution-Policy \
  --template-file infra/bootstrap/cfn-execution-policy.yaml --capabilities CAPABILITY_NAMED_IAM
aws cloudformation update-termination-protection --region us-west-2 \
  --stack-name Suas-Cdk-Execution-Policy --enable-termination-protection
cd infra && npm ci
node node_modules/aws-cdk/bin/cdk bootstrap \
  "aws://$ACCOUNT/us-west-2" "aws://$ACCOUNT/us-east-1" \
  --cloudformation-execution-policies "arn:aws:iam::$ACCOUNT:policy/SuasCdkExecution" \
  --termination-protection
```

Use the lockfile CLI, not `npx cdk@latest`. Re-run the bootstrap after a CDK upgrade that needs a newer
bootstrap version.

## 2. GitHub OIDC roles

[`infra/bootstrap/github-oidc.yaml`](../../infra/bootstrap/github-oidc.yaml) creates the OIDC provider and
two roles. Each trusts one GitHub Environment through the repository's immutable OIDC subject
(`gh api repos/scrimshawlife-ctrl/suas/actions/oidc/customization/sub` → `sub_claim_prefix`), and only from
`.github/workflows/staging-deploy.yml` on `main` (IAM's `token.actions.githubusercontent.com:job_workflow_ref`
key), so another workflow file or a branch copy that names the environment cannot assume either role. If the
owner changes the subject setting, update `SubjectPrefix`; if the repository is renamed, update
`WorkflowRepository`.

```sh
SUBJECT=$(gh api repos/scrimshawlife-ctrl/suas/actions/oidc/customization/sub --jq .sub_claim_prefix)
echo "$SUBJECT"   # repo:<owner>@<id>/<repo>@<id>; immutable subjects are on for this repository
aws cloudformation deploy --region us-west-2 --stack-name Suas-GitHub-OIDC \
  --template-file infra/bootstrap/github-oidc.yaml --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides "SubjectPrefix=$SUBJECT" WorkflowRepository=scrimshawlife-ctrl/suas
aws cloudformation update-termination-protection --region us-west-2 \
  --stack-name Suas-GitHub-OIDC --enable-termination-protection
aws cloudformation describe-stacks --region us-west-2 --stack-name Suas-GitHub-OIDC \
  --query 'Stacks[0].Outputs' --output table
```

| Role                      | Trusted environment           | Can                                                                                               |
| ------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------- |
| `suas-gha-staging-plan`   | `suas-synthetic-staging-plan` | Read `Suas-*` stack templates and the CDK bootstrap version (`cdk diff`); not the CDK lookup role |
| `suas-gha-staging-deploy` | `suas-synthetic-staging`      | Assume the CDK deploy and file-publishing roles; invoke only the migrate and job worker functions |

Neither role can read secrets or application SSM values, read Lambda configuration (it holds resolved secrets),
edit IAM, or invoke the API or the email relay. Every stack change, including the workflow's maintenance step, runs
as the CDK deploy role. On the first plan run, confirm that `cdk diff` falls back from the lookup role to the plan
role (it prints a warning); if it does not, grant only the missing read action. IAM Access Analyzer `ValidatePolicy` reports no
findings on the permission policies. On the trust policies it warns that a branch is recommended in `sub`:
these subjects are environment-scoped, and the `job_workflow_ref` condition plus the environment's branch policy
(step 4) enforce `main`. If the first plan run is refused at `AssumeRoleWithWebIdentity`, the token's
`job_workflow_ref` did not match: compare it with the condition before loosening anything.

## 3. Deploy-time parameters (before the first backend deploy)

The backend resolves these at each deploy (see "Fixture registry" and "Email" in `infra/README.md`). Type
the values yourself; they are synthetic identifiers or a sender address, never committed.

```sh
aws ssm put-parameter --region us-west-2 --type String --name /suas/staging/fixture-registry --value '<tenant>:<user id>,...'
aws ssm put-parameter --region us-west-2 --type String --name /suas/staging/fixture-mailbox --value '<mailbox>'
aws ssm put-parameter --region us-west-2 --type String --name /suas/staging/email-from --value '<Name> <address>'
```

## 4. GitHub settings

Repository variables (Settings → Secrets and variables → Actions → Variables), none of them secret:

| Variable                  | Value                                            |
| ------------------------- | ------------------------------------------------ |
| `AWS_ACCOUNT_ID`          | the staging account id                           |
| `AWS_PLAN_ROLE_ARN`       | `PlanRoleArn` output                             |
| `AWS_DEPLOY_ROLE_ARN`     | `DeployRoleArn` output                           |
| `SUAS_STAGING_API_ORIGIN` | `https://api.staging.suasqrf.com` (the `ApiUrl`) |
| `SUAS_STAGING_WEB_ORIGIN` | `https://staging.suasqrf.com` (the `WebUrl`)     |

Environments (a repository admin, the owner, configures protection):

- `suas-synthetic-staging-plan`: deployment branches `main` only. No reviewers: the plan job cannot change anything.
- `suas-synthetic-staging`: deployment branches `main` only, required reviewers, prevent self-review. Without
  reviewers, nothing stands between a dispatch and a deploy, so do not run the workflow until they are set.

## 5. Foundation stacks (blocked on the DNS decision)

`Suas-Dns` and `Suas-Staging-WebCert` are deployed by hand once; the workflow deploys only the backend and web
stacks (`--exclusively`) and refuses to run until both exist. The certificates validate through DNS in the
hosted zone, so they finish only after the domain decision is made and applied (see "Deploy order" in
`infra/README.md`). Do not change registrar or Cloudflare name servers to unblock this.

```sh
cd web && VITE_SUAS_API_BASE_URL=https://api.staging.suasqrf.com npm run build && cd ../infra
CDK_DEFAULT_ACCOUNT=$ACCOUNT SUAS_BUILD_COMMIT=$(git rev-parse HEAD) npm run synth:deploy
node node_modules/aws-cdk/bin/cdk deploy --app cdk.out Suas-Dns Suas-Staging-WebCert --exclusively
```

## 6. First workflow run

Dispatch **staging-deploy** with a main SHA and `scope=full`. The run deploys the backend in maintenance,
migrates, admits the API, runs one worker pass, enables the schedule, deploys the web app and runs the
`@public` STAGING suite. Then seed the fixtures through the migrate function
([`aws-staging-fixtures.md`](aws-staging-fixtures.md)) and put the Resend key into the relay secret
(`infra/README.md`, manual step 2).

To check the plumbing before DNS is ready, dispatch it and leave the deploy job unapproved: `gate`, `verify`,
`build` and `plan` prove OIDC, the bootstrap and the synth; `cdk diff` then lists every resource as new.

## Recovery

- A failed run leaves the backend in the mode it reached (often `maintenance`). Fix forward and dispatch a
  new SHA. To reopen traffic on the current code instead, dispatch the same SHA again.
- Rolling back means dispatching an older SHA. The workflow refuses when the deployed schema is newer than
  that build expects; repair forward instead (`deployment-rollback.md`).
