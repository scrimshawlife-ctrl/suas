# Branch protection — suas

Observed 2026-09-30. This file does not itself change GitHub settings.

```text
SPEC_018 = KEEP_BLOCKED
PRODUCTION_DEPLOYMENT = workflow_dispatch only, environment suas-synthetic-staging
```

## Observed

On 2026-09-30 the branch had no protection (HTTP 404). The settings below were then applied with the branch-protection API.

```text
pull_request_required: true
required_status_checks: verify
strict: true
conversation_resolution_required: true
force_push_blocked: true
deletion_blocked: true
required_approving_review_count: 0
enforce_admins: false
```

`enforce_admins` is false, so an admin can still bypass. That is an observed gap. Turning it on is a separate operator choice, because a solo maintainer cannot approve their own pull request and a red `verify` check would otherwise have no bypass.

`worker-deploy.yml` does not run on push. It requires the typed confirmation `deploy` and the GitHub Environment `suas-synthetic-staging`. That workflow is synthetic staging, not production authority.

## Target, where the operator can apply it

```text
main:
  pull_request_required: true
  required_status_checks:
    - verify
  conversation_resolution_required: true
  force_push_blocked: true
  deletion_blocked: true
```

`verify` is the existing pull-request job in `.github/workflows/verify.yml`. Do not require manual staging workflows (`worker-deploy`, `staging-acceptance`, `staging-migrate`, soak, recovery). Those are operator-gated and are not pull-request checks.

Approving-review count is not set here. A solo maintainer cannot approve their own pull request. Requiring a pull request plus the `verify` check is the control this file asks for.

Status for this repository: protection is applied as recorded above. `enforce_admins` remains an operator choice.
