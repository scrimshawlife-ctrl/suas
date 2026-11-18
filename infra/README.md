# SUAS infrastructure (AWS CDK)

TypeScript CDK app for the SUAS v1 STAGING environment in `us-west-2` (synthetic data only).
It follows `V1_PROJECT_PLAN.md` §6 in the SUAS-specs repository.

**Nothing has been deployed.** This app has only been synthesized and tested offline. There is no deploy
workflow yet, because the AWS account layout is undecided (plan §8 item 17). There is no production
stack either: production is gated by plan §7. The stack layout takes an environment config, so a
production set can be added later without restructuring.

## Safe by construction

- `npm run synth` runs the `aws-cdk` binary installed by `npm ci` (it does not call `npx`). Every `AWS_*` and `CDK_*` variable is removed, the metadata service
  and shared config files disabled, and `--no-lookups`. If anything tried to read from AWS, synth would
  fail rather than call it.
- No context lookup is used (`Vpc.fromLookup`, `HostedZone.fromLookup`, AMI lookups). The two availability
  zones come from `Fn::GetAZs`, resolved by CloudFormation. `cdk.context.json` is git-ignored.
- The account comes from `CDK_DEFAULT_ACCOUNT` at deploy time. The region is fixed to `us-west-2`.
  No account id, secret or key is committed. The one 12-digit number in the templates is the AWS-owned
  account that publishes the public Lambda Web Adapter layer; a test checks there are no others.

## Commands

Run `npm ci` at the repository root first: the Lambda code is bundled from the root `src/`, and the tests
validate configuration with the application's own validator. Then:

```sh
cd infra
npm ci
npm run check      # typecheck + vitest assertion tests + offline synth
npm run synth
```

Synth needs no Docker. esbuild bundles the Lambda code locally (see "Lambda package").

## Context values

Pass with `-c name=value` (or in `cdk.json`). Defaults are the values the user confirmed on 2026-11-05.

| Context                  | Default                                | Meaning                                                                                                                    |
| ------------------------ | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `rootDomain`             | `suasqrf.com`                          | Domain of the hosted zone                                                                                                  |
| `webHostname`            | `staging.suasqrf.com`                  | Web app (CloudFront)                                                                                                       |
| `apiHostname`            | `api.staging.suasqrf.com`              | HTTP API                                                                                                                   |
| `bedrockModelId`         | refused                                | R2.15 is not approved. Passing this context fails synth. Inference stays `disabled`.                                       |
| `allowPlaceholderModel`  | refused                                | Same refusal. It does not select a model and it does not mark a deployable template.                                       |
| `safetyCopyMode`         | `placeholder_test_only`                | `SUAS_SAFETY_COPY_MODE`. Matches the retired Worker staging; set `approved` to show the D-012 crisis copy. **Owner call.** |
| `browserTenantId`        | `00000000-0000-4000-8000-000000000001` | `SUAS_BROWSER_TENANT_ID`, the tenant new sign-ups join (same value the retired Worker used)                                |
| `availabilityZones`      | first two from `Fn::GetAZs`            | Comma list of `us-west-2` zones, if an endpoint service is missing in one                                                  |
| `webAdapterLayerVersion` | `30`                                   | Version of the AWS-published Lambda Web Adapter layer                                                                      |

Hostnames must be inside `rootDomain`, because certificates are validated in the zone this app owns.

## Stacks

| Stack                  | Region    | Contents                                                                                                                                                                                                                                                               |
| ---------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Suas-Dns`             | us-west-2 | Public hosted zone for `suasqrf.com` (retained on delete), the Resend mail records carried over from Cloudflare, `NameServers` output. No apex or `www` record. No SES identity (suas #305).                                                                           |
| `Suas-Staging-WebCert` | us-east-1 | DNS-validated ACM certificate for the web hostname (CloudFront needs us-east-1). Passed to the web stack with `crossRegionReferences`.                                                                                                                                 |
| `Suas-Staging-Backend` | us-west-2 | VPC (isolated subnets), VPC endpoints, RDS PostgreSQL 17 (no RDS Proxy, R14.1 proposal), secrets, assets bucket, API / job worker / migrate Lambdas, the email relay Lambda (outside the VPC), HTTP API with a custom domain, EventBridge Scheduler. No WebSocket API. |
| `Suas-Staging-Web`     | us-west-2 | Private S3 bucket, CloudFront distribution with OAC, `staging.suasqrf.com` A and AAAA alias, `web/dist` upload (only if `web/dist` exists at synth time).                                                                                                              |

### Email: Resend through a relay (suas #305)

Staging email (sign-in codes and notifications) goes out through Resend's HTTPS API. The VPC has no internet
egress, so the API and job worker never call Resend themselves. They invoke the **email relay** function
(`src/aws/email-relay-lambda.ts`, construct `lib/email-relay.ts`) through the Lambda interface endpoint and hand
it one rendered message with its idempotency key; it sends with the Resend adapter
(`src/notifications/resend-email.ts`, D-004) and answers with that adapter's acknowledgement.

- The relay runs **outside the VPC** with **no database setting** and its own role: it can write its log
  group and read its one secret, nothing else. The API and job worker roles may invoke the relay and no
  other function.
- The relay reads the Resend API key at run time from the secret named by the `EmailRelaySecretName` output,
  cached per container. The key is not in the template, any Lambda environment or any log. The sender
  (`SUAS_EMAIL_FROM`) comes from the SSM parameter `/suas/staging/email-from`, resolved at deploy and set on the
  relay only; there is no default address.
- Recipients: the API and job worker check the STAGING allowlist before invoking, and the relay checks it again
  before reading the secret. Only synthetic addresses and `+tag` addresses of the fixture mailbox pass.
- Status: a Resend `2xx` with an id is `SENT`; a `4xx` other than `409`/`429` is `UNDELIVERABLE` at once;
  `409`, `429`, `5xx` and timeouts are retried by the job outbox with the same `Idempotency-Key`. A lost invoke
  answer (timeout, dropped connection, relay crash) may follow a send, so it is `UNDELIVERABLE` at once with
  reason `relay_ambiguous_ack` (no blind retry). There are no Resend webhooks yet, so `DELIVERED` and `BOUNCED`
  are not reached.
- Until the secret holds the real key, every send is retried and then settles `UNDELIVERABLE`.

### Network

- 2 AZs, isolated subnets only. **No NAT gateway, no internet gateway, no route off the VPC.**
- S3 gateway endpoint, plus one interface endpoint (private DNS on) for each AWS service the code calls.
- The Lambda interface endpoint is in **one zone** only, the first isolated subnet (R14.1 proposal, lean synthetic
  STAGING). Private DNS resolves `lambda.us-west-2.amazonaws.com` to that endpoint's address from every subnet, and
  the VPC's local route carries traffic between zones, so the API and job worker reach it from either zone. If that
  zone fails, email relay invokes fail until it recovers. The sender treats a lost connection as ambiguous
  (`src/notifications/lambda-relay-sender.ts`), so those sends settle `UNDELIVERABLE` (`relay_ambiguous_ack`), not
  retried.
- Security groups: the Lambda group (API, job worker) and the migrate group to RDS on 5432, nothing else into the
  database group. Lambda egress is otherwise HTTPS only, and only the endpoint security group accepts it. The
  database is not public.
- The licence reader (suas-specs R10.1, proposal) would need the job worker to reach the reader's host, which is
  outside AWS. That egress waits on the owner's R9.2 decision (question 8) and is not built here: no NAT, no
  `SUAS_SCRY_BASE_URL`, and `SUAS_LICENCE_READER_MODE=disabled` on every function. Before staging turns the reader
  on, the largest payload the tunnel accepts must be measured (SCRY_LICENCE_FALLBACK.md L9.5), and
  `SUAS_LICENCE_SYNTHETIC_IIN` must be set on both the API and the job worker (they share one config schema).

### AWS services the staging template calls, and the endpoints they need

The Bedrock adapter (`src/inference/bedrock-inference.ts`) and the API Gateway push adapter
(`src/realtime/apigw-connection-push.ts`) stay in the repository. This template does not select
them and does not create `bedrock-runtime` or `execute-api` endpoints. R2.15 is not approved.
R6.12 is not accepted.

| Service             | SDK client               | Code that uses it                                                             | Endpoint           |
| ------------------- | ------------------------ | ----------------------------------------------------------------------------- | ------------------ |
| AWS Lambda (Invoke) | `@aws-sdk/client-lambda` | `src/notifications/lambda-relay-sender.ts` (`InvokeCommand`, the email relay) | interface `lambda` |
| Amazon S3           | `@aws-sdk/client-s3`     | `src/storage/s3-object-storage.ts` (put, get, delete)                         | gateway `s3`       |

Not needed: **Secrets Manager** inside the VPC (the in-VPC code reads configuration from environment variables;
only the relay, outside the VPC, reads its secret), **CloudWatch Logs** (the code never calls it; Lambda logging does not use the VPC), **STS/KMS**
(credentials come from the Lambda role).

### Assets bucket

Licence review images live under `licence-reviews/<review_id>/` in this bucket (SCRY_LICENCE_FALLBACK.md §2.3).
The prefix may keep no copies, and a prefix cannot opt out of bucket-wide versioning or a backup plan. So the
bucket has no versioning and no replication, and no AWS Backup plan exists in these stacks. Tests fail if
any of these appear; adding one would need a dedicated licence bucket first. A lifecycle rule
(`LicenceReviewsBackstop`) expires objects under the prefix after 30 days (the owner-set D-007 exception) and
aborts unfinished multipart uploads after 1 day. It is a backstop: the application deletes the images at the
decision.

### Database

PostgreSQL 17, `db.t4g.micro`, single-AZ, 20 GB gp3, encrypted, 7-day backups, deletion protection, final
snapshot on delete. `rds.force_ssl=1`. Credentials are generated into Secrets Manager (URL-safe
characters).

There is **no RDS Proxy** (R14.1 proposal, lean synthetic STAGING). The API, job worker and migrate functions all
connect to the instance endpoint directly, with `DATABASE_SSL_MODE=verify` (the certificate chain and the host name,
as libpq's `verify-full`; `src/db/pool.ts`) and the RDS CA bundle, shipped as
`assets/rds-global-bundle.crt` (public certificates, from `truststore.pki.rds.amazonaws.com`) and set as
`DATABASE_SSL_CA_FILE`. The migrate function would need a direct connection anyway (the migrator holds a session
advisory lock; plan §4.1). Each warm API or job-worker container holds up to `DATABASE_POOL_MAX=3` connections
(migrate holds 1), and without a proxy nothing pools them across containers. The account's Lambda concurrency
limit (1000) does not bound them, so reserved concurrency does (R14.1, SUAS-specs #100): **15 on the API, 2 on
the job worker and 1 on migrate**. Budget: 15 × 3 + 2 × 3 + 1 × 1 (migrate) = **52 connections**. The parameter
group pins `max_connections` at **80**, below the `db.t4g.micro` default (LEAST({DBInstanceClassMemory/9531392}, 5000), at
most 112 for 1024 MiB), so the budget is checked against the limit the instance has; 3 of those are reserved for superusers. It is a static
parameter: changing it needs a reboot. Tests keep the budget at 60 or less and below `max_connections` less 3, and an
alarm fires at 70 connections (see "Alarms"). Lambda throttles a 16th concurrent API request instead of letting it fail
on a database connection. Under the deploy workflow (`-c deploymentPipeline=true`, `lib/deployment-mode.ts`) the
API and job worker are set to 0 while a mode blocks them and back to 15 and 2 once it does not; migrate keeps 1.
See "Known risks".

### Cost

Rough monthly estimates in `us-west-2` from the R14.1 proposal, not checked against an AWS bill: about **$55/mo as
first designed** versus about **$26/mo lean**. The difference is RDS Proxy (about $22/mo, billed at its 2-vCPU
minimum) and the Lambda interface endpoint's second zone (about $7.30/mo per zone). See "Before production".

### Lambda package

`lib/lambda-code.ts` builds one directory used by the four functions (API, job worker, migrate, email relay). esbuild still bundles
`src/aws/websocket-lambda.ts` with the other entries so the push handler keeps compiling, and the
directory also carries `package.json`,
`migrations/`, `run.sh` and the RDS CA bundle. These are the on-disk files the code resolves beside the
bundle (`src/provenance/build-info.ts`, `src/db/migration-files.ts`). The AWS SDK is bundled, not taken from
the runtime. Provenance (`SUAS_BUILD_COMMIT`, `SUAS_BUILD_TIMESTAMP`) is stamped from git at synth time
(the commit date, so the template is stable per commit), or from `-c buildCommit=` / `-c buildTimestamp=`.

| Function   | Handler                | Network SG | Notes                                                                                                        |
| ---------- | ---------------------- | ---------- | ------------------------------------------------------------------------------------------------------------ |
| API        | `run.sh` (Web Adapter) | Lambda     | Node 22, arm64, 512 MB, 30 s, behind the HTTP API. `SUAS_MIGRATIONS_MODE=validate`. Reserved concurrency 15. |
| Job worker | `job-worker.handler`   | Lambda     | One pass (`job-worker --once`): widening sweep, then one batch of due outbox jobs. Reserved concurrency 2.   |
| Migrate    | `migrate.handler`      | Migrate    | `migrate apply`, direct to RDS. Invoked by hand. No custom resource. Reserved concurrency 1.                 |

EventBridge Scheduler invokes the job worker every minute (the Scheduler minimum for a rate). Overlapping runs are
safe because jobs are claimed with leases. The two handlers `src/aws/job-worker-lambda.ts` and
`src/aws/migrate-lambda.ts` (and the shared loop in `src/jobs/worker.ts`) were added for this app; they throw on
failure so the invocation fails.

### Secrets

The application reads configuration from environment variables only (`src/config/schema.ts`). The session secret
(64 generated characters) and the database credentials are in Secrets Manager and are injected as CloudFormation
dynamic references (`{{resolve:secretsmanager:...}}`), resolved at deploy time. **The template never contains the
values, but the resolved values are visible to anyone who can read the Lambda configuration** (for example
`lambda:GetFunctionConfiguration`). The owner accepted this for synthetic staging data. See "Before production".
Two more secrets follow the same pattern. `SUAS_FINGERPRINT_KEY` (64 generated letters and digits, valid base64 of
48 bytes) keys the VA identity and licence hashes (VA_CONFIRMATION_FLOW.md §2.1). It goes to the API and job
worker, with its id `SUAS_FINGERPRINT_KEY_ID=staging-1` as a plain value. To rotate it, move the pair to
`SUAS_FINGERPRINT_KEY_PREVIOUS` / `_PREVIOUS_ID`, set a new key and id, and deploy. `SUAS_SCRY_API_TOKEN` (64
generated characters) is the licence reader's bearer token and goes to the job worker only; the same value is set
on the reader. No role has `secretsmanager:GetSecretValue`.
Rotating a secret needs a redeploy. The API, job worker and migrate functions all connect to the instance as the
generated master user (`suas_admin`, an `rds_superuser`).

### Environment variables (API function)

All values are plain except the three marked secret. Other functions get the subset they need (see `lib/backend-stack.ts`);
each function's environment is checked against the application's own config validator in the tests.

| Variable                                                                                        | Value                                                                                                                                |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `SUAS_ENV`                                                                                      | `STAGING`                                                                                                                            |
| `SUAS_SPEC_VERSION`, `SUAS_RELEASE_MANIFEST`                                                    | from `src/release/pins.ts` (so a re-pin follows automatically)                                                                       |
| `SUAS_ALLOW_REAL_EXTERNAL_EFFECTS`                                                              | `false`                                                                                                                              |
| `SUAS_SESSION_SECRET`                                                                           | secret (Secrets Manager)                                                                                                             |
| `SUAS_FINGERPRINT_KEY`, `SUAS_FINGERPRINT_KEY_ID`                                               | secret (Secrets Manager), `staging-1`; API and job worker only                                                                       |
| `DATABASE_URL`                                                                                  | secret: `postgresql://user:password@<instance address>:5432/suas` on every in-VPC function (no RDS Proxy, R14.1 proposal)            |
| `DATABASE_SSL_MODE`, `DATABASE_SSL_CA_FILE`, `DATABASE_POOL_MAX`                                | `verify`, `/var/task/rds-global-bundle.crt`, `3` on the API and job worker; the migrate function sets `DATABASE_POOL_MAX` to `1`     |
| `SUAS_MIGRATIONS_MODE`                                                                          | `validate` (the migrate function uses `apply`; the job worker uses `off`)                                                            |
| `SUAS_BROWSER_AUTH_MODE`, `SUAS_BROWSER_TENANT_ID`                                              | `email_otp`, the `browserTenantId` context                                                                                           |
| `SUAS_EMAIL_MODE`, `SUAS_EMAIL_RELAY_FUNCTION`                                                  | `resend`, the relay function name (API and job worker). `RESEND_API_KEY` and `SUAS_EMAIL_FROM` are set on the relay only.            |
| `SUAS_SMS_MODE`                                                                                 | `sink` (as today's staging)                                                                                                          |
| `SUAS_AWS_REGION`                                                                               | `us-west-2`                                                                                                                          |
| `SUAS_MODEL_INFERENCE_MODE`                                                                     | `disabled`. R2.15 is not approved, so no model id is set.                                                                            |
| `SUAS_OBJECT_STORAGE_MODE`, `SUAS_S3_BUCKET`                                                    | `s3`, the assets bucket (API and job worker)                                                                                         |
| `SUAS_ID_VERIFICATION_MODE`                                                                     | `disabled` (no provider chosen). `fake` is refused on STAGING (D-052).                                                               |
| `SUAS_LICENCE_READER_MODE`                                                                      | `disabled` on every function (R10.1 proposal; reader egress undecided, R9.2). `SUAS_SCRY_BASE_URL` is not set.                       |
| `SUAS_CHAT_PUSH_MODE`                                                                           | `disabled`. R6.12 is not accepted. `SUAS_CHAT_WS_ENDPOINT` and `SUAS_CHAT_WS_PUBLIC_URL` are not set.                                |
| `SUAS_CORS_ALLOWED_ORIGINS`                                                                     | `https://<webHostname>` (`https://staging.suasqrf.com`), API function only (R11.3, D-038). See "Cross-origin web client".            |
| `SUAS_STAGING_FIXTURE_REGISTRY`                                                                 | the SSM parameter `/suas/staging/fixture-registry`, resolved at deploy; also on the job worker and migrate functions (R11.5, D-052). |
| `SUAS_STAGING_FIXTURE_MAILBOX`                                                                  | the SSM parameter `/suas/staging/fixture-mailbox` (one real mailbox), resolved at deploy; same three functions (R11.7).              |
| `SUAS_TRANSPORTATION_ADAPTER_MODE`, `SUAS_SHELTER_ADAPTER_MODE`, `SUAS_FOOD_ADAPTER_MODE`       | `fake`                                                                                                                               |
| `SUAS_PEER_SUPPORT_ADAPTER_MODE`                                                                | `manual`                                                                                                                             |
| `SUAS_SUPPORT_SIGNAL_MODE`, `SUAS_SAFETY_COPY_MODE`, `SUAS_SENSITIVE_AGGREGATE_REPORTING`       | `fixture`, the `safetyCopyMode` context, `disabled`                                                                                  |
| `SUAS_HTTP_HOST`, `SUAS_HTTP_PORT`                                                              | `0.0.0.0`, `8080`                                                                                                                    |
| `SUAS_LOG_LEVEL`                                                                                | `info`                                                                                                                               |
| `SUAS_BUILD_COMMIT`, `SUAS_BUILD_TIMESTAMP`                                                     | stamped at synth                                                                                                                     |
| `AWS_LAMBDA_EXEC_WRAPPER`, `AWS_LWA_PORT`, `AWS_LWA_READINESS_CHECK_PATH`, `AWS_LWA_ASYNC_INIT` | `/opt/bootstrap`, `8080`, `/api/v0/health`, `true` (Lambda Web Adapter)                                                              |

`SUAS_DEMO_FIXED_CODE` is not set. `RESEND_API_KEY` is not used.

### Cross-origin web client (R11.3)

The web app on `staging.suasqrf.com` calls `api.staging.suasqrf.com` with Bearer, a different origin, so the API
lists the web origin in `SUAS_CORS_ALLOWED_ORIGINS` (contributor proposal R11.3, specs #75, not released; D-038
parsing rules are released in 0.7.0). Consequence (AUTH.md §9.3): with a non-empty allowlist the legacy `/app`
session cookie is `SameSite=None; Secure` instead of `Strict`, and the allowlisted origin has credentialed access to
the `/app` session. The web client does not use that cookie (it sends Bearer, and `/api/v0` never reads cookies), so
the trust boundary is the staging web origin only. Changing `webHostname` changes the listed origin with it.

### Fixture registry and seed (R11.5)

STAGING admits only the `tenant-id:user-id` pairs in `SUAS_STAGING_FIXTURE_REGISTRY` (D-052); an empty registry
admits nobody. The stack reads the registry from the SSM String parameter `/suas/staging/fixture-registry`.
CloudFormation resolves it at each deploy, so no function reads SSM at run time and none has an `ssm:` grant;
change the value, then redeploy `Suas-Staging-Backend`. The parameter must exist before the first deploy. The
registry holds identifiers only.

Sign-in on STAGING is an emailed code, which a synthetic address never receives. So a fixture address may also be
a plus address `local+tag@domain` of the one mailbox in `/suas/staging/fixture-mailbox` (R11.7, contributor
proposal, specs #75, not released): a mailbox that supports plus addressing delivers `<local>+vet1@<domain>` to `<local>@<domain>`, so every
fixture's code arrives in that inbox. The bare mailbox is never a fixture address. The mailbox is the one real
address in this setup: it lives only in SSM and, after deploy, in the Lambda configuration; never in code or the
template. Steps:
[docs/runbooks/aws-staging-fixtures.md](../docs/runbooks/aws-staging-fixtures.md).

### IAM

Each function has its own role with no managed policies: write to its own log group, plus the ENI actions Lambda
needs in a VPC (not scopable). Added grants: `lambda:InvokeFunction` on the email relay only (API and job worker);
S3 get/put/delete on the assets bucket objects plus `s3:ListBucket` on the bucket itself (API; without it a
missing key returns AccessDenied instead of NoSuchKey). This covers the licence images too: submit, the admin image
route and deletion. The job worker gets S3 get/delete on `licence-reviews/*` only, plus `s3:ListBucket` on the
bucket with no condition, so a missing image reads as 404 (`PHOTOS_GONE`), not 403 (SCRY_LICENCE_FALLBACK.md
L4.7). AWS documents the 404 only for an unconditioned grant; listing shows key names, which are opaque ids. There is no `bedrock:InvokeModel` grant and no
`execute-api:ManageConnections` grant. The ENI actions are the six in `AWSLambdaVPCAccessExecutionRole`,
including `ec2:DescribeSubnets`. The email relay is not in the VPC: its role has no ENI actions, only its log
group and `secretsmanager:GetSecretValue`/`DescribeSecret` on its own secret.

### Logs

CloudWatch log groups for every function and the HTTP API access log, retained 30 days. The API access log is a
fixed metadata record (request id, route key, status, latency): no bodies, paths, query strings or addresses.
The API (Fastify/pino) logs
method, path and status per request, never bodies: no code in `src/intake`, `src/catalog`, `src/inference` or
`src/http` logs request bodies or intake text, and `src/inference/bedrock-inference.ts` logs only the outcome.

### Alarms

Each of the API and job-worker log groups has a metric filter for the messages the code logs on failure:
`job_failed` and `sweep_failed` (`src/jobs/worker.ts`) and `chat push failed` (`src/chat/send.ts`). An alarm per
group fires on one or more in 5 minutes. A second filter and alarm on each of those groups count the email relay
failures, `relay_ambiguous_ack` (the invoke's answer was lost) and `relay_unavailable` (Lambda refused the invoke),
from the `email_send` outcome line (`src/notifications/channels.ts`); losing the one Lambda endpoint zone shows here.
They match terms, because the Node runtime prefixes the job worker's lines. An alarm on the instance's
`DatabaseConnections` (maximum over 5 minutes) fires at 70, between the budget of 52 and `max_connections` 80.
**There is no notification target yet**, so the alarms only show in the
CloudWatch console until someone picks a topic (an SNS topic and subscriber are not created here). The inline
job dispatcher in the API logs a different message (`[suas] job <type> failed`, `src/app.ts`) that these filters
do not match.

### Log retention of CDK-owned helper functions

Application function log groups use 30-day retention (`RetentionDays.ONE_MONTH`). The site upload sets that
same retention on its own log group, and only when `web/dist/index.html` exists at synth so the upload is created.
CDK-owned helper functions that do not take a log group in this code (the cross-region export reader/writer, the
VPC default-security-group restrictor, and the S3 auto-delete helper) are left on the AWS default, which does not
expire those logs. No alarm topic and no Content-Security-Policy are added by this app.

### Web

Private bucket (block public access, SSL enforced), CloudFront with Origin Access Control, redirect to HTTPS, TLS
1.2 minimum, AWS managed security-headers policy, 403/404 answered with `/index.html`. A Content-Security-Policy is
not set yet. **Build the SPA for staging before deploying the web stack:**
`cd web && VITE_SUAS_API_BASE_URL=https://api.staging.suasqrf.com npm run build`. The `web/dist` that
`web npm run check` produces has no API URL and is wrong for deployment.

## Deploy order (not done yet)

Do not deploy until the AWS account layout is decided. When it is, from `infra/` with credentials for the chosen
account (`export CDK_DEFAULT_ACCOUNT=<account id>`; never commit it). Do not pass `bedrockModelId`:

1. `cdk bootstrap` the account for `us-west-2` **and** `us-east-1` (cross-region references and the certificate need both).
2. Export the Cloudflare zone (manual step 1), then `cdk deploy Suas-Dns`. Note the `NameServers` output. That note is prep only.
3. **Do not change the registrar name servers.** The nameserver cutover waits for the suas-specs #61 R6.8 gate and an
   owner decision (manual step 1). Until both are recorded, leave the registrar pointing at Cloudflare. Certificates
   and DKIM stay pending while the domain still resolves from Cloudflare. Keep the zone export and the `NameServers`
   output for that later decision. Do not apply them.
4. `cdk deploy Suas-Staging-WebCert Suas-Staging-Backend` only after that gate and an owner decision allow a cutover.
   These stacks wait for DNS validation and will not finish before then. Do not change name servers to unblock them.
5. **Run the migrate function (manual step 4).**
6. Build the web app (above), then `cdk deploy Suas-Staging-Web`.
7. Run the fixture seed (manual step 6), then smoke-test.

## Manual steps

1. **Prepare DNS. Do not change name servers.**
   1. Export the zone from the Cloudflare dashboard (the records found by `dig` are listed below, but
      `dig` cannot list a whole zone).
   2. `Suas-Dns` already recreates the mail records found (`resend._domainkey` TXT, `send` TXT and `send` MX) in
      the Route 53 zone. Add by hand anything else in the export that must keep working, inside this zone only.
   3. Record the four values in the `NameServers` output. Do not set them at the registrar.
   4. The nameserver cutover waits for the suas-specs #61 R6.8 gate and an owner decision. Until both are
      recorded, the domain keeps resolving from Cloudflare, and `staging.suasqrf.com` and the apex `suasqrf.com`
      stay on the Worker. A cutover would stop those names until they are recreated: `Suas-Staging-Web` would make
      `staging.suasqrf.com` an alias to CloudFront, and the apex gets no record from this app. The CloudFront
      certificate and API certificate stay pending until that decision. That wait is expected.
2. **Set the sender, and put the Resend API key into the relay secret** (you do this yourself; no tool or agent
   reads or writes the key).
   1. Before the first deploy, store the sender, an address on a domain verified in the Resend account:
      `aws ssm put-parameter --name /suas/staging/email-from --type String --value "<Name> <address>"`.
   2. After the first deploy, store the key in the secret named by the `EmailRelaySecretName` output. Type the
      command yourself so the key stays out of files; a leading space keeps it out of shell history in most shells:
      ` aws secretsmanager put-secret-value --secret-id <EmailRelaySecretName> --secret-string '{"RESEND_API_KEY":"<key>"}'`
   3. No redeploy is needed: the relay reads the secret on its next cold start, and again after a refused send.
   4. To rotate, create a new key in Resend, `put-secret-value` again, then revoke the old one.
3. **Do not enable Bedrock for this template.** R2.15 is not approved, and the API sets
   `SUAS_MODEL_INFERENCE_MODE=disabled`. Model access in the Bedrock console is not a step for this synth.
4. **Run the migrate function** after every deploy that adds migrations. From a shell with credentials:
   `aws lambda invoke --function-name <MigrateFunctionName output> --cli-binary-format raw-in-base64-out out.json`
   and read `out.json` (`schema_version`, `applied_now`). Until it has run, the API fails closed at startup
   because `SUAS_MIGRATIONS_MODE=validate` finds pending migrations.
5. Accept the AWS BAA in AWS Artifact before any real Veteran data (plan §7). Staging stays synthetic.
6. **Create the fixture registry before the first backend deploy, and seed it after migrating.** Pick up to ten
   new user ids (`uuidgen | tr A-Z a-z`) and write them under the browser tenant:
   `aws ssm put-parameter --name /suas/staging/fixture-registry --type String --value "00000000-0000-4000-8000-000000000001:<user id>,..."`.
   Also store the mailbox that receives fixture codes (it must exist before the first deploy):
   `aws ssm put-parameter --name /suas/staging/fixture-mailbox --type String --value "<owner mailbox>"`.
   After the migrate function has run, create those users and the fixture Resources:
   `aws lambda invoke --function-name <MigrateFunctionName output> --cli-binary-format raw-in-base64-out --payload '{"action":"seed-staging-fixtures","fixtures":[{"user_id":"<user id>","email":"<name>@example.invalid"}]}' out.json`.
   Every address must be synthetic (`example.com|net|org`, `.invalid`, `.test`, `.example`, `.localhost`) or a
   plus address of the mailbox (`<local>+<tag>@<domain>`, tag `[a-z0-9-]{1,32}`), which is the way to receive codes. The
   action refuses outside STAGING, refuses any other address or any user id not in the registry, checks the
   schema version first, and a re-run creates nothing new. Details:
   [docs/runbooks/aws-staging-fixtures.md](../docs/runbooks/aws-staging-fixtures.md).

## Records on Cloudflare today

Found with `dig` on 2026-11-05 (zone on `romina.ns.cloudflare.com` and `rustam.ns.cloudflare.com`).

| Name                            | Type | Value                                                                                                                                                                                                                        | Needs recreating in Route 53?                                                                                                                      |
| ------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `suasqrf.com`                   | A    | `104.21.28.254`, `172.67.171.51` (Cloudflare proxy)                                                                                                                                                                          | Not now. A later cutover would take the current site down. This app does not create it. The cutover waits for the R6.8 gate and an owner decision. |
| `suasqrf.com`                   | AAAA | `2606:4700:3035::ac43:ab33`, `2606:4700:3035::6815:1cfe`                                                                                                                                                                     | Same                                                                                                                                               |
| `staging.suasqrf.com`           | A    | same two Cloudflare IPs                                                                                                                                                                                                      | Not now. If a later cutover is approved, the web stack makes `staging.suasqrf.com` an alias to CloudFront. Do not change name servers for this.    |
| `resend._domainkey.suasqrf.com` | TXT  | `p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDrMvHRhU05sXko0q5D1sB8fH9gt051BBQgB46SggGREJahiVsC3/tmMV4QNQjBl5vi5ih8TFNArxy0O/i1pkMnXBBIGgOWDqF3Jrvl8rHAcM98JQuSX+cQggOwo4WrPBMI6aX1RtjTZIcSX2rKiy/g6dXHTqISnj4HAmTpcC13zQIDAQAB` | **Created by `Suas-Dns`.** Public DNS value, not a secret                                                                                          |
| `send.suasqrf.com`              | TXT  | `"v=spf1 include:amazonses.com ~all"`                                                                                                                                                                                        | **Created by `Suas-Dns`**                                                                                                                          |
| `send.suasqrf.com`              | MX   | `10 feedback-smtp.us-east-1.amazonses.com.`                                                                                                                                                                                  | **Created by `Suas-Dns`**                                                                                                                          |

The Cloudflare A and AAAA addresses are Cloudflare edge addresses, so the apex is a proxied record pointing at the
Cloudflare Worker. They cannot be copied into Route 53 as the origin; the apex needs a decision (point it at AWS,
or keep the zone on Cloudflare until then). No apex or `www` TXT, MX or CAA record, no `_dmarc`, and no `www`
record were found; `dig` cannot list a whole zone (AXFR is refused), so export the zone from the Cloudflare
dashboard as prep. Do not change name servers. Any later cutover waits for the suas-specs #61 R6.8 gate and an
owner decision.

## Known risks (unverified offline)

- **Chat push is not in this template.** R6.12 is not accepted. `SUAS_CHAT_PUSH_MODE=disabled`. The push
  adapter remains in `src/realtime/` and is not selected. Chat over REST does not need it.
- **Endpoint availability by zone.** An interface endpoint cannot be created in a zone that does not offer the
  service. If a deploy fails for that reason, pass `-c availabilityZones=us-west-2a,us-west-2b` (or other zones).
  The Lambda endpoint uses the first zone listed.
- **One Lambda endpoint zone.** If that zone fails, email relay invokes fail until it recovers and those sends
  settle `UNDELIVERABLE`, not retried; the relay failure alarms show it (see "Network", "Alarms"). Mitigation: an
  endpoint in the second zone (about $7.30/mo) before any real Veteran data, or sooner if the owner decides.
- **Database connections without RDS Proxy.** Each warm API or job-worker container keeps up to 3 connections
  open, including while Lambda has frozen it, until the container is retired. Reserved concurrency (API 15, job
  worker 2, migrate 1) holds the total to 52 (see "Database"); `max_connections` is pinned at 80 and an alarm fires
  at 70. Nothing in the database limits connections per role. The cap also limits staging throughput: past 15 concurrent API requests, Lambda throttles. Every cold
  container opens TLS straight to the instance.
- **Cold starts and the API Gateway limit.** The HTTP API integration times out after 29 seconds. Inference is
  disabled, so this template does not make a Bedrock call.
- `npm audit` reports a moderate `minimatch` issue bundled inside `aws-cdk-lib` itself; it affects build-time code
  only, and the fix is a CDK upgrade.

## Before production

Not needed for synthetic staging, required before any real Veteran data (plan §7 gates also apply):

- Fetch secrets at run time (needs application code), or use RDS Proxy IAM authentication. Today the session
  secret and the database credentials are CloudFormation dynamic references, visible in the Lambda configuration.
- A least-privilege `suas_app` database role for the API, WebSocket and job worker functions. Today they use the
  generated master user, which is an `rds_superuser`. Only the migrate function needs schema-change rights.
- Secret rotation: a rotation needs a redeploy while secrets are injected as environment variables.
- A notification target for the alarms, and a CSP on the web distribution.
- Restore RDS Proxy (or an equivalent connection pooler) for the API and job worker, and place the Lambda interface
  endpoint in every zone the functions run in. Lean synthetic STAGING removed both (R14.1 proposal).
