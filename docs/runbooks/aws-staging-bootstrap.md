# AWS foundation for the staging deploy workflow (synthetic STAGING)

One-time, human-run setup that lets [`staging-deploy.yml`](../../.github/workflows/staging-deploy.yml)
deploy the CDK app in [`infra/`](../../infra/README.md). Routine deploys then run from GitHub through OIDC;
nobody stores AWS keys in GitHub. This does not authorize PRODUCTION, a pilot, real Veteran data or real
external effects, and a deploy is not SPEC-018 evidence.

**HOLD:** this follow-up implements the proposal in
[SUAS-specs #112](https://github.com/scrimshawlife-ctrl/suas-specs/pull/112).
It does not release that proposal or authorize these commands. Before operation, release the owner
choices (including R14.5 and the Resend amendment), repin the runtime, review the exact synthesized
change, and obtain a separate synthetic-STAGING deployment decision.

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
   API and worker reserve 0 in maintenance, but migrate still reserves 1. This does not fit that limit. Ask for headroom:
   `aws service-quotas request-service-quota-increase --region us-west-2 --service-code lambda --quota-code L-B99A9384 --desired-value 1000`.

## 1. CDK bootstrap (both regions)

The CloudFormation execution role gets all three policies `SuasCdkExecution`, `SuasCdkServices` and
`SuasCdkEdge`
([`infra/bootstrap/cfn-execution-policy.yaml`](../../infra/bootstrap/cfn-execution-policy.yaml)).

For an existing account, first disable the GitHub deployment identity and any other principals
that can submit updates through the application execution role. Keep them disabled through the
legacy-role check below; pause queued/running deployments before changing the bootstrap policies.

```sh
aws cloudformation deploy --region us-west-2 --stack-name Suas-Cdk-Execution-Policy \
  --template-file infra/bootstrap/cfn-execution-policy.yaml --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides "StagingApiHostname=$STAGING_API_HOSTNAME" "StagingWebHostname=$STAGING_WEB_HOSTNAME"
aws cloudformation update-termination-protection --region us-west-2 \
  --stack-name Suas-Cdk-Execution-Policy --enable-termination-protection
cd infra && npm ci
node node_modules/aws-cdk/bin/cdk bootstrap \
  "aws://$ACCOUNT/us-west-2" "aws://$ACCOUNT/us-east-1" \
  --cloudformation-execution-policies "arn:aws:iam::$ACCOUNT:policy/SuasCdkExecution,arn:aws:iam::$ACCOUNT:policy/SuasCdkServices,arn:aws:iam::$ACCOUNT:policy/SuasCdkEdge" \
  --termination-protection
```

Set `STAGING_API_HOSTNAME` and `STAGING_WEB_HOSTNAME` to the exact DNS names in the reviewed
assembly before bootstrap. They are required parameters, with no wildcard or default. Confirm they
match the API and web certificates; a hostname change requires a reviewed bootstrap update.

CloudFront `CreateDistribution` needs `Resource: "*"`, as do cache-policy and origin-access-control
creation. The policy enumerates those actions; existing-resource operations retain ARN scoping.
`CreateDistributionWithTags` is an API operation, not an IAM action; tagged creation uses
`CreateDistribution` and the applicable `TagResource` grant.

ACM's [API permissions guide](https://docs.aws.amazon.com/acm/latest/userguide/authen-apipermissions.html)
and [authorization reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_acm.html)
disagree about certificate-ARN scoping for `RequestCertificate`. Both permit `Resource: "*"`.
Use that only for this action, with DNS validation, the supported regions, no private CA, and
`ForAllValues:StringEquals` for the two exact hostnames. The non-null condition prevents a missing
domain list from satisfying the set condition. Existing-certificate actions remain scoped to the
account's ARNs. This resolves the implementation choice without claiming the previous scope was
proven broken. Before operation, validate the policy and simulate both hostname allows, a mixed
allowed/foreign SAN set, wildcard/foreign names, a missing domain key, a private CA, email validation
and an unsupported region. Perform actual certificate issuance only in an authorized deployment window.

Use the lockfile CLI, not `npx cdk@latest`. Re-run the bootstrap after a CDK upgrade that needs a newer
bootstrap version.

### Region-restricted accounts

The workflow and these bootstrap policies support only the four-stack `us-west-2` layout with
`Suas-Staging-WebCert` in `us-east-1`. `deploymentPipeline=true` rejects another region, default URLs,
or an imported certificate before any AWS operation. Direct synth retains those configuration modes,
but this boundary does not qualify them for deployment. Extending the policy, release-record stack
map and workflow together requires a separate reviewed change.

### Permissions boundary acceptance

The bootstrap also creates `SuasStagingRuntimeBoundary`. Every generated role, including late-created
cross-region helpers, receives it. The execution policies require it on role creation, inline-policy writes, managed-policy attachment
and trust-policy updates, and forbid its removal, replacement or policy modification. Application identities still need their own grants;
the boundary alone grants nothing. Provision and update the boundary from the separate administrator
identity, never from the application execution role.

Before enabling or re-enabling deployment access, the independent administrator must inventory **all**
existing `Suas-*` roles, including helpers from older deployments. New templates do not prove that
existing roles have a boundary. For each role, review its owner, trust policy, inline/attached policies
and required actions. Attach `SuasStagingRuntimeBoundary` to the reviewed application/helper roles
using the administrator identity, then read back the boundary ARN. Do not blindly adopt an unknown
role by name. Resolve unexpected roles or broader legacy privileges before continuing, and retain
the inventory and validation result as bootstrap evidence. An empty inventory is valid on first setup.
Do this before application updates: CloudFormation is not guaranteed to attach a new boundary before
updating the role's policies. Boundary changes can also restrict an existing workload immediately.

AWS supports `iam:PermissionsBoundary` on `PutRolePolicy`, `AttachRolePolicy` and
`UpdateAssumeRolePolicy`, but **not** `PassRole` (see the
[official IAM action reference](https://servicereference.us-east-1.amazonaws.com/v1/iam/iam.json)).
PassRole is restricted by generated role name, account and receiving service; its safety also depends
on the qualified role namespace. Keep independent administrators from introducing unbounded roles
into that namespace while deployment access is enabled. Repeat this qualification after any such
administrator change. New-role enforcement plus the boundary removal/replacement denies preserve
the invariant for routine deploys; this is a one-time bootstrap transition, not per-deploy ceremony.

Policies restrict resources by account, region and generated names where those identifiers exist.
S3 bucket/object grants also check `s3:ResourceAccount` and the supported regions, including CDK
asset reads. Bucket ARNs have no account field; a matching name, even one containing an account ID,
is not ownership evidence. Include a foreign-owned matching-prefix bucket in negative simulations.
EC2 network resources and service-generated IDs still have account-wide scope in the two regions;
Route 53 zones and CloudFront resources have generated-ID scope. Read inventories and the creation
APIs without resource-level support retain explicit `*` resources. This is a bounded synthetic
account policy, not tenant isolation or production least privilege. Do not place unrelated workloads
in the account. After foundation creation, tighten generated identifiers where feasible.

Offline tests check syntax, size, boundary attachment and forbidden privileges. Before any authorized
run, require fresh IAM Access Analyzer validation and positive/negative policy simulations for the
exact account: expected deployment actions pass; outside-account resources, wrong regions,
unbounded role creation, inline-policy/trust updates or policy attachment to an unbounded or
wrong-boundary role, boundary changes and production secrets fail. The same supported role updates
with the approved boundary must succeed. Confirm managed attachment still accepts only the existing
AWSLambdaBasicExecutionRole allow-list. PassRole evidence must use the qualified role inventory;
do not pretend that an unsupported condition validates the role boundary. Test real CloudFormation
create/update/rollback only inside a separately authorized synthetic window. Do not add a broad
policy to bypass a denied action.

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
role (it prints a warning); if it does not, grant only the missing read action. The earlier Access Analyzer result predates these policy changes; rerun `ValidatePolicy` before operation. On the trust policies it warns that a branch is recommended in `sub`:
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

Environment secret `SUAS_STAGING_ALARM_EMAIL` must hold one monitored recipient. It is passed as the
required `AlarmEmail` NoEcho parameter, never baked into the assembly. A missing value fails before
mutation. SNS creates a pending email subscription: its recipient must confirm it once and a test
notification must be received before accepting STAGING. Changing the address requires reconfirmation.

VA stays disabled in the current workflow build. An approved VA-enabled assembly requires a pre-existing
LLC-owned sandbox secret in this account and region under `suas/staging/`, using the AWS managed
Secrets Manager encryption key. Pass its complete ARN as `Suas-Staging-Backend:VaSandboxSecretArn`
when deploying that assembly. There is no default or placeholder. Do not delete an older managed
secret during transition until the external secret is provisioned and verified; the current stack's
change set must be checked for that removal. A customer KMS key requires a separate reviewed decrypt
grant. ARN syntax cannot prove ownership or key validity; metadata review and an approved synthetic
smoke test are acceptance evidence. Never print the key.

Environments (a repository admin, the owner, configures protection):

- `suas-synthetic-staging-plan`: deployment branches `main` only, with the recorded required reviewer.
  The plan job is read-only, but removing its reviewer requires a separate explicit owner decision.
- `suas-synthetic-staging`: deployment branches `main` only, required reviewers, prevent self-review. Without
  reviewers, nothing stands between a dispatch and a deploy, so do not run the workflow until they are set.

Protect `main` with required checks and review; disable administrator bypass for deployment protection
where supported. Verify actual repository and environment settings through read-back before an
approved run. The YAML environment name alone is not a protection rule. Current settings have not
been changed by this proposal.

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

- On a failure after mutation, the shell attempts to return the existing backend to `maintenance`
  with its current template and preserved parameters. It waits up to 600 seconds for the update and
  reports `maintenance` only after reading that parameter and a `CREATE_COMPLETE` or `UPDATE_COMPLETE`
  stack status. Otherwise it reports `UNKNOWN`. This is stack-level evidence, not a runtime drift check.
- The original failing exit code is preserved. No later promotion runs. A fixed-message notification
  goes to `Suas-Staging-Alarms`; notification failure is itself visible in the job. No AWS error or
  provider payload is included. The deploy role can publish only to that topic.
- Job cancellation, runner termination, hard timeout, an in-progress rollback, missing foundation, or
  lost credentials can prevent recovery. Treat these as `UNKNOWN`, inspect CloudFormation and actual
  concurrency/schedule state, and restore maintenance before retrying. Do not infer that failure means
  traffic is closed. Recovery does not undo database migrations or stop already-running invocations.
- After inspection, repair forward and dispatch a separately approved SHA. Even retrying the same SHA
  requires a new environment approval.
- Rolling back means dispatching an older SHA. The workflow refuses when the deployed schema is newer than
  that build expects; repair forward instead (`deployment-rollback.md`).
