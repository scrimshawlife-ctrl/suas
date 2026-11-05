# SUAS infrastructure (AWS CDK)

TypeScript CDK app for the SUAS v1 STAGING environment in `us-west-2` (synthetic data only).
It follows `V1_PROJECT_PLAN.md` §6 in the SUAS-specs repository.

**Nothing has been deployed.** This app has only been synthesized and tested offline. There is no deploy
workflow yet, because the AWS account layout is undecided (plan §8 item 17). There is no production
stack either: production is gated by plan §7. The stack layout takes an environment config, so a
production set can be added later without restructuring.

## Safe by construction

- `npm run synth` runs `cdk synth` with every `AWS_*` and `CDK_*` variable removed, the metadata service
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
npm run synth -- -c bedrockModelId=<model or inference profile id>
```

Synth needs no Docker. esbuild bundles the Lambda code locally (see "Lambda package").

## Context values

Pass with `-c name=value` (or in `cdk.json`). Defaults are the values the user confirmed on 2026-11-05.

| Context                  | Default                                | Meaning                                                                                                                          |
| ------------------------ | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `rootDomain`             | `suasqrf.com`                          | Domain of the hosted zone                                                                                                        |
| `webHostname`            | `staging.suasqrf.com`                  | Web app (CloudFront)                                                                                                             |
| `apiHostname`            | `api.staging.suasqrf.com`              | HTTP API                                                                                                                         |
| `wsHostname`             | `ws.staging.suasqrf.com`               | WebSocket API                                                                                                                    |
| `bedrockModelId`         | none: **required**                     | Bedrock model or inference profile id. Undecided (plan §8 item 5), so synth fails without it.                                    |
| `allowPlaceholderModel`  | unset                                  | `true` lets CI synth without a model. The template is marked "PLACEHOLDER MODEL"; never deploy it.                               |
| `emailFrom`              | `no-reply@` + root domain              | SES sender (`SUAS_EMAIL_FROM`); must be in the verified domain                                                                   |
| `safetyCopyMode`         | `placeholder_test_only`                | `SUAS_SAFETY_COPY_MODE`. Matches today's `wrangler.jsonc` staging; set `approved` to show the D-012 crisis copy. **Owner call.** |
| `browserTenantId`        | `00000000-0000-4000-8000-000000000001` | `SUAS_BROWSER_TENANT_ID`, the tenant new sign-ups join (same value as `wrangler.jsonc`)                                          |
| `availabilityZones`      | first two from `Fn::GetAZs`            | Comma list of `us-west-2` zones, if an endpoint service is missing in one                                                        |
| `webAdapterLayerVersion` | `30`                                   | Version of the AWS-published Lambda Web Adapter layer                                                                            |

Hostnames must be inside `rootDomain`, because certificates are validated in the zone this app owns.

## Stacks

| Stack                  | Region    | Contents                                                                                                                                                                                                          |
| ---------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Suas-Dns`             | us-west-2 | Public hosted zone for `suasqrf.com` (retained on delete), SES domain identity with Easy DKIM CNAMEs, `NameServers` output. No apex or `www` record.                                                              |
| `Suas-Staging-WebCert` | us-east-1 | DNS-validated ACM certificate for the web hostname (CloudFront needs us-east-1). Passed to the web stack with `crossRegionReferences`.                                                                            |
| `Suas-Staging-Backend` | us-west-2 | VPC (isolated subnets), VPC endpoints, RDS PostgreSQL 17 + RDS Proxy, secrets, assets bucket, API / WebSocket / job worker / migrate Lambdas, HTTP and WebSocket APIs with custom domains, EventBridge Scheduler. |
| `Suas-Staging-Web`     | us-west-2 | Private S3 bucket, CloudFront distribution with OAC, `staging.suasqrf.com` A and AAAA alias, `web/dist` upload (only if `web/dist` exists at synth time).                                                         |

The SES identity is in `Suas-Dns` because an SES identity belongs to a domain, not to an environment.

### Network

- 2 AZs, isolated subnets only. **No NAT gateway, no internet gateway, no route off the VPC.**
- S3 gateway endpoint, plus one interface endpoint (private DNS on) for each AWS service the code calls.
- Security groups: Lambda to RDS Proxy on 5432, RDS Proxy to RDS on 5432, migrate function to RDS on 5432.
  Lambda egress is HTTPS only, and only the endpoint security group accepts it. The database is not public.

### AWS services the API calls, and the endpoints they need

Found by reading `src/` (no other `@aws-sdk` client exists; `package.json` lists exactly these four).

| Service                    | SDK client                                | Code that uses it                                                   | Endpoint                    |
| -------------------------- | ----------------------------------------- | ------------------------------------------------------------------- | --------------------------- |
| Amazon SES (SESv2 API)     | `@aws-sdk/client-sesv2`                   | `src/notifications/ses-email.ts` (`SendEmailCommand`)               | interface `email`           |
| Amazon Bedrock Runtime     | `@aws-sdk/client-bedrock-runtime`         | `src/inference/bedrock-inference.ts` (`ConverseCommand`)            | interface `bedrock-runtime` |
| Amazon S3                  | `@aws-sdk/client-s3`                      | `src/storage/s3-object-storage.ts` (put, get, delete object)        | gateway `s3`                |
| API Gateway Management API | `@aws-sdk/client-apigatewaymanagementapi` | `src/realtime/apigw-connection-push.ts` (`PostToConnectionCommand`) | interface `execute-api`     |

Not needed: **Secrets Manager** (the code never calls it: configuration is read from environment
variables), **CloudWatch Logs** (the code never calls it; Lambda logging does not use the VPC), **STS/KMS**
(credentials come from the Lambda role).

### Database

PostgreSQL 17, `db.t4g.micro`, single-AZ, 20 GB gp3, encrypted, 7-day backups, deletion protection, final
snapshot on delete. `rds.force_ssl=1`. Credentials are generated into Secrets Manager (URL-safe
characters). RDS Proxy requires TLS. AWS docs checked on 2026-11-05: RDS Proxy supports RDS for PostgreSQL 17
in US West (Oregon), and no instance class restriction is documented (burstable T classes are named as good
candidates).

The Lambdas connect with `DATABASE_SSL_MODE=verify`, with no CA file for the Proxy (its certificates chain to
Amazon Trust Services roots, which Node already trusts). The **migrate** function connects to the instance
directly (the migrator holds a session advisory lock; plan §4.1) and needs the RDS CA bundle, which is shipped
as `assets/rds-global-bundle.crt` (public certificates, from `truststore.pki.rds.amazonaws.com`) and set as
`DATABASE_SSL_CA_FILE`.

### Lambda package

`lib/lambda-code.ts` builds one directory used by all four functions. esbuild bundles each entry from the
repository (`src/main.ts`, `src/aws/websocket-lambda.ts`, `src/aws/job-worker-lambda.ts`,
`src/aws/migrate-lambda.ts`) into ESM `.mjs` files, and the directory also carries `package.json`,
`migrations/`, `run.sh` and the RDS CA bundle. These are the on-disk files the code resolves beside the
bundle (`src/provenance/build-info.ts`, `src/db/migration-files.ts`). The AWS SDK is bundled, not taken from
the runtime. Provenance (`SUAS_BUILD_COMMIT`, `SUAS_BUILD_TIMESTAMP`) is stamped from git at synth time
(the commit date, so the template is stable per commit), or from `-c buildCommit=` / `-c buildTimestamp=`.

| Function   | Handler                | Network SG | Notes                                                                               |
| ---------- | ---------------------- | ---------- | ----------------------------------------------------------------------------------- |
| API        | `run.sh` (Web Adapter) | Lambda     | Node 22, arm64, 512 MB, 30 s, behind the HTTP API. `SUAS_MIGRATIONS_MODE=validate`. |
| WebSocket  | `websocket.handler`    | Lambda     | `$connect` (ticket in the query), `$disconnect`, `$default` all to one function     |
| Job worker | `job-worker.handler`   | Lambda     | One pass (`job-worker --once`): widening sweep, then one batch of due outbox jobs   |
| Migrate    | `migrate.handler`      | Migrate    | `migrate apply`, direct to RDS. Invoked by hand. No custom resource.                |

EventBridge Scheduler invokes the job worker every minute (the Scheduler minimum for a rate). Overlapping runs are
safe because jobs are claimed with leases. The two handlers `src/aws/job-worker-lambda.ts` and
`src/aws/migrate-lambda.ts` (and the shared loop in `src/jobs/worker.ts`) were added for this app; they throw on
failure so the invocation fails.

### Secrets

The application reads configuration from environment variables only (`src/config/schema.ts`). The session secret
(64 generated characters) and the database credentials are in Secrets Manager and are injected as CloudFormation
dynamic references (`{{resolve:secretsmanager:...}}`), resolved at deploy time. **The template never contains the
values, but the resolved values are visible to anyone who can read the Lambda configuration** (for example
`lambda:GetFunctionConfiguration`). That is acceptable for synthetic staging data. Reading secrets at run time
(or IAM authentication to RDS Proxy) would need application code and should be decided before production.
Rotating a secret needs a redeploy.

### Environment variables (API function)

All values are plain except the two marked secret. Other functions get the subset they need (see `lib/backend-stack.ts`);
each function's environment is checked against the application's own config validator in the tests.

| Variable                                                                                        | Value                                                                                                     |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `SUAS_ENV`                                                                                      | `STAGING`                                                                                                 |
| `SUAS_SPEC_VERSION`, `SUAS_RELEASE_MANIFEST`                                                    | from `src/release/pins.ts` (so a re-pin follows automatically)                                            |
| `SUAS_ALLOW_REAL_EXTERNAL_EFFECTS`                                                              | `false`                                                                                                   |
| `SUAS_SESSION_SECRET`                                                                           | secret (Secrets Manager)                                                                                  |
| `DATABASE_URL`                                                                                  | secret: `postgresql://user:password@<proxy endpoint>:5432/suas`                                           |
| `DATABASE_SSL_MODE`, `DATABASE_POOL_MAX`                                                        | `verify`, `3`                                                                                             |
| `SUAS_MIGRATIONS_MODE`                                                                          | `validate` (the migrate function uses `apply`; WebSocket and job worker `off`)                            |
| `SUAS_BROWSER_AUTH_MODE`, `SUAS_BROWSER_TENANT_ID`                                              | `email_otp`, the `browserTenantId` context                                                                |
| `SUAS_EMAIL_MODE`, `SUAS_EMAIL_FROM`                                                            | `ses`, the `emailFrom` context                                                                            |
| `SUAS_SMS_MODE`                                                                                 | `sink` (as today's staging)                                                                               |
| `SUAS_AWS_REGION`                                                                               | `us-west-2`                                                                                               |
| `SUAS_MODEL_INFERENCE_MODE`, `SUAS_BEDROCK_MODEL_ID`                                            | `bedrock`, the `bedrockModelId` context                                                                   |
| `SUAS_OBJECT_STORAGE_MODE`, `SUAS_S3_BUCKET`                                                    | `s3`, the assets bucket                                                                                   |
| `SUAS_ID_VERIFICATION_MODE`                                                                     | `fake` (no provider chosen; allowed outside PRODUCTION, `src/config/schema.ts` `validateAwsCapabilities`) |
| `SUAS_CHAT_PUSH_MODE`                                                                           | `apigw`                                                                                                   |
| `SUAS_CHAT_WS_ENDPOINT`                                                                         | `https://<ws api id>.execute-api.us-west-2.amazonaws.com/staging` (management endpoint)                   |
| `SUAS_CHAT_WS_PUBLIC_URL`                                                                       | `wss://ws.staging.suasqrf.com` (what browsers open; no stage path)                                        |
| `SUAS_CORS_ALLOWED_ORIGINS`                                                                     | `https://staging.suasqrf.com`                                                                             |
| `SUAS_TRANSPORTATION_ADAPTER_MODE`, `SUAS_SHELTER_ADAPTER_MODE`, `SUAS_FOOD_ADAPTER_MODE`       | `fake`                                                                                                    |
| `SUAS_PEER_SUPPORT_ADAPTER_MODE`                                                                | `manual`                                                                                                  |
| `SUAS_SUPPORT_SIGNAL_MODE`, `SUAS_SAFETY_COPY_MODE`, `SUAS_SENSITIVE_AGGREGATE_REPORTING`       | `fixture`, the `safetyCopyMode` context, `disabled`                                                       |
| `SUAS_HTTP_HOST`, `SUAS_HTTP_PORT`                                                              | `0.0.0.0`, `8080`                                                                                         |
| `SUAS_LOG_LEVEL`                                                                                | `info`                                                                                                    |
| `SUAS_BUILD_COMMIT`, `SUAS_BUILD_TIMESTAMP`                                                     | stamped at synth                                                                                          |
| `AWS_LAMBDA_EXEC_WRAPPER`, `AWS_LWA_PORT`, `AWS_LWA_READINESS_CHECK_PATH`, `AWS_LWA_ASYNC_INIT` | `/opt/bootstrap`, `8080`, `/api/v0/health`, `true` (Lambda Web Adapter)                                   |

`SUAS_DEMO_FIXED_CODE` is not set. `RESEND_API_KEY` is not used.

### IAM

Each function has its own role with no managed policies: write to its own log group, plus the ENI actions Lambda
needs in a VPC (not scopable). Added grants: SES `ses:SendEmail` on the one domain identity (API and job worker);
Bedrock `bedrock:InvokeModel` on the configured model only (API); S3 get/put/delete on the assets bucket objects
(API); `execute-api:ManageConnections` on the WebSocket API (API). A model id with a geography prefix (`us.`,
`eu.`, `global.`...) is treated as an inference profile: the profile in this account plus the underlying
foundation model with a wildcard **region** only, because the profile routes across regions.

### Logs

CloudWatch log groups for every function and the HTTP API access log, retained 30 days. The API access log is a
fixed metadata record (request id, route key, status, latency): no bodies, paths, query strings or addresses.
No WebSocket access log is kept, since it could capture the connect ticket. The API (Fastify/pino) logs
method, path and status per request, never bodies: no code in `src/intake`, `src/catalog`, `src/inference` or
`src/http` logs request bodies or intake text, and `src/inference/bedrock-inference.ts` logs only the outcome.

### Web

Private bucket (block public access, SSL enforced), CloudFront with Origin Access Control, redirect to HTTPS, TLS
1.2 minimum, AWS managed security-headers policy, 403/404 answered with `/index.html`. A Content-Security-Policy is
not set yet. **Build the SPA for staging before deploying the web stack:**
`cd web && VITE_SUAS_API_BASE_URL=https://api.staging.suasqrf.com npm run build`. The `web/dist` that
`web npm run check` produces has no API URL and is wrong for deployment.

## Deploy order (not done yet)

Do not deploy until the AWS account layout is decided. When it is, from `infra/` with credentials for the chosen
account (`export CDK_DEFAULT_ACCOUNT=<account id>`; never commit it) and `-c bedrockModelId=...`:

1. `cdk bootstrap` the account for `us-west-2` **and** `us-east-1` (cross-region references and the certificate need both).
2. `cdk deploy Suas-Dns`. Note the `NameServers` output.
3. **Move the registrar NS records (manual step 1).** Certificates and DKIM cannot validate before this.
4. `cdk deploy Suas-Staging-WebCert Suas-Staging-Backend` (these wait for DNS validation).
5. **Run the migrate function (manual step 4).**
6. Build the web app (above), then `cdk deploy Suas-Staging-Web`.
7. Seed or create synthetic users as the staging runbooks describe, then smoke-test.

## Manual steps

1. **Move the name servers at the registrar.** After `Suas-Dns` is deployed, set the registrar's NS records to the
   four values in the `NameServers` output. First recreate in Route 53 any record that must keep working (see
   "Records on Cloudflare today"). Until then the domain resolves from Cloudflare, and the CloudFront certificate,
   API certificate and DKIM records stay pending.
2. **Leave the sandbox in SES** (a new account is in the SES sandbox: it can send only to verified addresses).
   Verify test recipient addresses for staging, or open an AWS support request for production access (plan §7).
   Check that the domain identity shows "Verified" and DKIM "Successful" once DNS is delegated.
3. **Enable Bedrock model access** for the chosen model in the Bedrock console (us-west-2). Without it, the API
   reports the model capability unavailable and the plain request form is shown.
4. **Run the migrate function** after every deploy that adds migrations. From a shell with credentials:
   `aws lambda invoke --function-name <MigrateFunctionName output> --cli-binary-format raw-in-base64-out out.json`
   and read `out.json` (`schema_version`, `applied_now`). Until it has run, the API fails closed at startup
   because `SUAS_MIGRATIONS_MODE=validate` finds pending migrations.
5. Accept the AWS BAA in AWS Artifact before any real Veteran data (plan §7). Staging stays synthetic.

## Records on Cloudflare today

Found with `dig` on 2026-11-05 (zone on `romina.ns.cloudflare.com` and `rustam.ns.cloudflare.com`).

| Name                            | Type | Value                                                                                                                                                                                                                        | Needs recreating in Route 53?                                                       |
| ------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `suasqrf.com`                   | A    | `104.21.28.254`, `172.67.171.51` (Cloudflare proxy)                                                                                                                                                                          | Yes, or the current site goes down at the NS move. This app does not create it.     |
| `suasqrf.com`                   | AAAA | `2606:4700:3035::ac43:ab33`, `2606:4700:3035::6815:1cfe`                                                                                                                                                                     | Same                                                                                |
| `staging.suasqrf.com`           | A    | same two Cloudflare IPs                                                                                                                                                                                                      | **No: replaced.** The web stack makes `staging.suasqrf.com` an alias to CloudFront. |
| `resend._domainkey.suasqrf.com` | TXT  | `p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDrMvHRhU05sXko0q5D1sB8fH9gt051BBQgB46SggGREJahiVsC3/tmMV4QNQjBl5vi5ih8TFNArxy0O/i1pkMnXBBIGgOWDqF3Jrvl8rHAcM98JQuSX+cQggOwo4WrPBMI6aX1RtjTZIcSX2rKiy/g6dXHTqISnj4HAmTpcC13zQIDAQAB` | Only while Resend (D-004) is still used for mail                                    |
| `send.suasqrf.com`              | TXT  | `"v=spf1 include:amazonses.com ~all"`                                                                                                                                                                                        | Same (Resend sending subdomain)                                                     |
| `send.suasqrf.com`              | MX   | `10 feedback-smtp.us-east-1.amazonses.com.`                                                                                                                                                                                  | Same                                                                                |

The Cloudflare A and AAAA addresses are Cloudflare edge addresses, so the apex is a proxied record pointing at the
Cloudflare Worker. They cannot be copied into Route 53 as the origin; the apex needs a decision (point it at AWS,
or keep the zone on Cloudflare until then). No apex or `www` TXT, MX or CAA record, no `_dmarc`, and no `www`
record were found; `dig` cannot list a whole zone (AXFR is refused), so export the zone from the Cloudflare
dashboard before the move to be sure nothing was missed.

## Known risks (unverified offline)

- **WebSocket push from isolated subnets.** AWS docs say that with private DNS on the `execute-api` endpoint, "you
  can't access the default endpoint of a public API Gateway API from your VPC endpoint. You can access an API with
  a custom domain name." The push adapter posts to the default execute-api URL
  (`src/config/schema.ts` accepts nothing else for `SUAS_CHAT_WS_ENDPOINT`). If `PostToConnection` fails in staging,
  chat still works over REST and only live updates are lost (look for `chat push failed` in the API log group).
  Fallbacks: allow the custom domain as the management endpoint, or add a non-VPC pusher function. Undecided.
- **Endpoint availability by zone.** An interface endpoint cannot be created in a zone that does not offer the
  service. If a deploy fails for that reason, pass `-c availabilityZones=us-west-2a,us-west-2b` (or other zones).
- **Cold starts and the API Gateway limit.** The HTTP API integration times out after 29 seconds; the Bedrock call
  in the adapter allows 30 seconds.
- `npm audit` reports a moderate `minimatch` issue bundled inside `aws-cdk-lib` itself; it affects build-time code
  only, and the fix is a CDK upgrade.
