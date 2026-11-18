#!/usr/bin/env bash
# Deploys one verified synthetic-STAGING release (.github/workflows/staging-deploy.yml).
#
# Order: quiesce the deployed backend on its own template and wait out its longest function
# timeout, deploy the new backend still in maintenance, migrate privately, then admit the API,
# then one worker pass, then the schedule, then the web app. Every step must pass; on failure
# the stack stays in its current mode and nothing re-enables traffic (CI_CD_ARCHITECTURE.md §7).
# Never prints Lambda configuration.
set -euo pipefail

: "${CDK_OUT:?}" "${RELEASE_JSON:?}" "${SUAS_BUILD_COMMIT:?}" "${API_ORIGIN:?}" "${SCOPE:?}"
readonly REGION=us-west-2
readonly BACKEND=Suas-Staging-Backend
WORK="$(mktemp -d)"
readonly WORK

cdk() { node infra/node_modules/aws-cdk/bin/cdk --app "$CDK_OUT" --no-notices --no-version-reporting "$@"; }
release() { node --import tsx/esm scripts/ci/staging-release.ts "$@"; }
step() { echo "::group::$*"; }
done_step() { echo "::endgroup::"; }

# One stack output, or empty when the stack does not exist yet. Any other error is fatal.
output() {
  local err value
  err="$WORK/describe.err"
  if value=$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$1" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue | [0]" --output text 2>"$err"); then
    [ "$value" = None ] && value=''
    printf '%s' "$value"
  elif grep -q 'does not exist' "$err"; then
    printf ''
  else
    cat "$err" >&2
    return 1
  fi
}

require_stack() {
  aws cloudformation describe-stacks --region "$2" --stack-name "$1" --query 'Stacks[0].StackStatus' \
    --output text >/dev/null || {
    echo "$1 ($2) must exist first: deploy it by hand (docs/runbooks/aws-staging-bootstrap.md)." >&2
    exit 1
  }
}

deploy_backend() {
  cdk deploy "$BACKEND" --exclusively --require-approval never \
    --parameters "$BACKEND:DeploymentMode=$1"
}

# Runs one AWS CLI command as the CDK deploy role, the only identity allowed to change stacks.
# Fails closed: empty or partial keys would leave the CLI on the caller's own identity, so the
# keys must be complete and must sign in as exactly that role before the command runs.
as_cdk_deploy_role() {
  local role session creds key secret token arn
  role="cdk-hnb659fds-deploy-role-${CALLER_ACCOUNT}-${REGION}"
  session="suas-quiesce-${GITHUB_RUN_ID:-local}"
  creds=$(aws sts assume-role --role-session-name "$session" \
    --role-arn "arn:aws:iam::${CALLER_ACCOUNT}:role/${role}" \
    --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text)
  read -r key secret token <<<"$creds"
  for value in "$key" "$secret" "$token"; do
    if [ -z "$value" ] || [ "$value" = None ]; then
      echo "Assuming $role returned no complete credentials; stopping." >&2
      exit 1
    fi
  done
  arn=$(AWS_ACCESS_KEY_ID="$key" AWS_SECRET_ACCESS_KEY="$secret" AWS_SESSION_TOKEN="$token" \
    aws sts get-caller-identity --query Arn --output text)
  if [ "$arn" != "arn:aws:sts::${CALLER_ACCOUNT}:assumed-role/${role}/${session}" ]; then
    echo "Assumed identity $arn is not the CDK deploy role; stopping." >&2
    exit 1
  fi
  AWS_ACCESS_KEY_ID="$key" AWS_SECRET_ACCESS_KEY="$secret" AWS_SESSION_TOKEN="$token" "$@"
}

# Puts the deployed backend into maintenance with its current template and parameters.
quiesce() {
  local current
  current=$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$BACKEND" \
    --query "Stacks[0].Parameters[?ParameterKey=='DeploymentMode'].ParameterValue | [0]" --output text)
  if [ "$current" = maintenance ]; then return 0; fi
  if [ "$current" = None ]; then
    echo "$BACKEND has no DeploymentMode parameter; it was not deployed by this pipeline." >&2
    exit 1
  fi
  aws cloudformation describe-stacks --region "$REGION" --stack-name "$BACKEND" \
    --query 'Stacks[0].Parameters[].ParameterKey' --output json |
    node -e 'const keys = JSON.parse(require("fs").readFileSync(0, "utf8"));
      console.log(JSON.stringify(keys.map((k) => k === "DeploymentMode"
        ? { ParameterKey: k, ParameterValue: "maintenance" }
        : { ParameterKey: k, UsePreviousValue: true })));' >"$WORK/quiesce-params.json"
  local exec_role
  exec_role=$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$BACKEND" \
    --query 'Stacks[0].RoleARN' --output text)
  as_cdk_deploy_role aws cloudformation update-stack --region "$REGION" --stack-name "$BACKEND" \
    --use-previous-template --role-arn "$exec_role" --parameters "file://$WORK/quiesce-params.json" \
    --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND >/dev/null
  aws cloudformation wait stack-update-complete --region "$REGION" --stack-name "$BACKEND"
}

# Invokes the backend's migrate or worker function by its full ARN in the release account and
# region, so the result checks are about the backend's own function, not what it reports.
invoke() {
  local name target
  name=$(output "$BACKEND" "$2")
  target=$(release invoke-target "$RELEASE_JSON" "$1" "$name" "$CALLER_ACCOUNT")
  aws lambda invoke --region "$REGION" --function-name "$target" --cli-binary-format raw-in-base64-out \
    --cli-read-timeout 360 --payload '{}' "$WORK/$1.json" >"$WORK/$1.meta.json"
}

step "Verify the release artifact"
release verify "$CDK_OUT" "$RELEASE_JSON"
CALLER_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
readonly CALLER_ACCOUNT
require_stack Suas-Dns "$REGION"
require_stack Suas-Staging-WebCert us-east-1
deployed_schema=$(output "$BACKEND" ExpectedSchemaVersion)
done_step

if [ "$SCOPE" = full ]; then
  step "Quiesce the deployed backend"
  release check-schema-order "$RELEASE_JSON" "$deployed_schema"
  # Assigned first so set -e stops on a failed read; inside `[ ]` it would skip quiesce.
  deployed_api=$(output "$BACKEND" ApiFunctionName)
  if [ -n "$deployed_api" ]; then
    # The deployed functions hold the in-flight work, so their timeouts set the wait.
    as_cdk_deploy_role aws cloudformation get-template --region "$REGION" --stack-name "$BACKEND" \
      --query TemplateBody --output json >"$WORK/deployed-backend.json"
    quiesce
    drain=$(release drain "$RELEASE_JSON" "$WORK/deployed-backend.json")
    echo "Waiting ${drain}s for in-flight API and worker invocations to finish."
    sleep "$drain"
  fi
  done_step

  step "Deploy the backend in maintenance"
  deploy_backend maintenance
  done_step

  step "Migrate"
  invoke migrate MigrateFunctionName
  release check-migration "$WORK/migrate.json" "$WORK/migrate.meta.json" "$RELEASE_JSON"
  done_step

  step "Admit the API"
  deploy_backend api
  curl --fail --silent --show-error --max-time 30 "$API_ORIGIN/api/v0/health" >"$WORK/health.json"
  release check-health "$WORK/health.json"
  done_step

  step "Run one job worker pass"
  deploy_backend worker
  invoke worker JobWorkerFunctionName
  release check-worker "$WORK/worker.json" "$WORK/worker.meta.json"
  done_step

  step "Enable the job worker schedule"
  deploy_backend live
  done_step
else
  expected=$(release field "$RELEASE_JSON" expectedSchemaVersion)
  if [ "$deployed_schema" != "$expected" ]; then
    echo "Web-only deploy needs the deployed backend at schema $expected (found '${deployed_schema}')." >&2
    exit 1
  fi
fi

step "Deploy the web app"
cdk deploy Suas-Staging-Web --exclusively --require-approval never
done_step

step "Public acceptance against the deployed API"
SUAS_E2E_BASE_URL="$API_ORIGIN" npm run test:e2e:staging:public
done_step

echo "Deployed ${SUAS_BUILD_COMMIT} (${SCOPE}). Authenticated acceptance needs synthetic sessions and is not claimed."
