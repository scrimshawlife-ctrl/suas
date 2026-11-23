# AWS STAGING fixture users and Resources

R11.5 (suas-specs #75, released in 0.10.0). Applies to the AWS CDK staging in `infra/` only.
STAGING admits only explicitly provisioned synthetic principals (D-052, ENVIRONMENT.md §3, released in 0.8.0).
The database is in isolated subnets with no bastion, so the migrate function seeds it.

## What the seed does

`{"action":"seed-staging-fixtures"}` on the migrate function (`src/aws/migrate-lambda.ts`,
`src/staging/fixture-seed.ts`):

- refuses unless `SUAS_ENV=STAGING` and real external effects are off;
- refuses, before any write, an address that is neither synthetic nor a plus address of the fixture mailbox
  (below), a user id that is not in
  `SUAS_STAGING_FIXTURE_REGISTRY`, a registry user with no address, or a repeated id or address;
- checks the database schema version, then in one transaction:
  - creates each registry user with its registry id, `ACTIVE`, county `SANTA_CLARA` (an existing user is set
    `ACTIVE` and given the county if it has none; one with another address is refused);
  - drafts and publishes four synthetic Resources (one per category, names ending in "(synthetic)", source link
    `https://fixtures.example.invalid/suas-staging-resources`) through the Resource Draft publish
    (RESOURCES.md §5.1). The reviewer of record is `staging-fixture-publisher@example.invalid`, a `SUSPENDED`
    user outside the registry that can never sign in.
- A re-run creates nothing new. The result lists counts and the seeded `tenant-id:user-id` pairs, never addresses.

It does not mark anyone verified, and it seeds no SUAS admin. A seeded user can help others at once. To request
help, the user opens the request gate the same way anyone does: VETERAN_VERIFICATION.md §21 (released in 0.10.0)
opens it for a `VERIFIED` row of any of its methods, and a `VERIFIED` `SELF_ATTESTATION` row is written by
`POST /api/v0/veterans/me/verification/commands/self-attest` ("Tell us you served" on the web Verify page;
`src/http/routes/veterans.ts`). That works on STAGING whatever the VA mode, unless the user holds an unlifted
`REVOKED` row.

## Fixture addresses and sign-in codes (R11.7)

R11.7 (specs #75, released in 0.10.0). Sign-in on STAGING is an emailed code, and a synthetic
address (`@example.invalid`) never receives mail. So a fixture address may also be a plus address of the one real
mailbox stored in `/suas/staging/fixture-mailbox`:

- Address form `<local>+<tag>@<domain>`, where `<local>@<domain>` is the mailbox (case does not matter) and the
  tag is 1-32 of `a-z`, `0-9`, `-`.
- Pick one tag per fixture and say what it is for, for example `vet1`, `vet2`, `helper1`. Each tag is a separate
  SUAS user; two fixtures cannot share one address.
- A mailbox that supports plus addressing delivers every plus address to it, so all fixture codes arrive in the
  owner's inbox, addressed to the tagged form. Sign in on the web app with the tagged address and read the code there.
- The bare mailbox is never accepted, so the owner's own address is never a fixture user.
- Keep the mailbox out of the repository: it lives only in SSM (and, after deploy, in the Lambda configuration).

Synthetic addresses still work for fixtures that never need to sign in.

## Steps

1. Pick up to ten user ids and store the registry (identifiers only) before the first backend deploy:

   ```sh
   T=00000000-0000-4000-8000-000000000001   # the browserTenantId context
   aws ssm put-parameter --name /suas/staging/fixture-registry --type String \
     --value "$T:$(uuidgen | tr A-Z a-z),$T:$(uuidgen | tr A-Z a-z)"
   ```

   Store the mailbox that receives the codes the same way (one plain address, no `+tag`):

   ```sh
   aws ssm put-parameter --name /suas/staging/fixture-mailbox --type String --value "<owner mailbox>"
   ```

   To change either later, `--overwrite` and redeploy `Suas-Staging-Backend`: CloudFormation reads the values at
   deploy. An invalid value makes every function fail its config check at start.

2. Deploy, then run the migrate function with no payload (infra/README.md manual step 4).
3. Seed, with one address per registry user (a plus address of the mailbox, or synthetic):

   ```sh
   aws lambda invoke --function-name <MigrateFunctionName output> \
     --cli-binary-format raw-in-base64-out \
     --payload '{"action":"seed-staging-fixtures","fixtures":[{"user_id":"<id 1>","email":"<local>+vet1@<domain>"},{"user_id":"<id 2>","email":"<local>+helper1@<domain>"}]}' \
     out.json
   cat out.json
   ```

   A refusal fails the invocation (`FunctionError` in the CLI output, the message in `out.json`) and writes nothing.

## Public demo mode (R16 proposal, not released)

Round 16 (R16.1–R16.5) is a contributor proposal awaiting the owner's decision. Do not deploy it before the owner
releases it and lifts the staging maintenance hold.

- Turn it on with `cdk deploy Suas-Staging-Backend -c publicDemo=true`, and build the web app with
  `VITE_SUAS_PUBLIC_DEMO=enabled`. Deploying without the context turns it off again.
- Anyone can sign up with their own address and receive a code; the fixture registry and the plus-address rule no
  longer limit who signs in or who receives mail. Registered fixture users and their sessions keep working.
- Every `POST /api/v0/auth/challenges` must carry `demo_acknowledged: true`, or the API answers `400` for every
  address alike.
- The `/app` HTML sign-in is off: `POST /app/auth/challenges` and `POST /app/auth/verify` answer `503` with a page
  that points to the web app, and create no challenge. Sign-in and sign-up go through the web app only.
- Abuse bounds (owner review on #363). API Gateway throttles `POST /api/v0/auth/challenges` and
  `POST /app/auth/challenges` at `-c publicDemoThrottleRate` rps (default 2) and `-c publicDemoThrottleBurst`
  (default 5) each, as best-effort defence in depth. The app then enforces its own settings, each a positive integer
  (an invalid value stops startup):

  | Setting                                   | Default | Bound                                                                                                                                                                                                    |
  | ----------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `SUAS_PUBLIC_DEMO_DAILY_SIGNUP_CAP`       | `200`   | New addresses (no account yet) sent a sign-up code per day, all together. Existing users are never blocked by it. Audit `SIGN_UP_CAP_REACHED`.                                                           |
  | `SUAS_PUBLIC_DEMO_ADDRESS_DAILY_CAP`      | `5`     | Email challenges (EMAIL_OTP or MAGIC_LINK) per day to one address with no account; `+tag` variants share one budget. Existing accounts keep only the 15-minute limit. Audit `ADDRESS_DAILY_CAP_REACHED`. |
  | `SUAS_PUBLIC_DEMO_ROUTE_LIMIT_PER_MINUTE` | `120`   | Challenge requests per minute over both challenge routes. Over it: `429 RATE_LIMITED` with `Retry-After`.                                                                                                |

  Over either daily cap the answer is still `202` and nothing is sent. Capping only addresses with no account leaves a
  small enumeration side channel (known addresses still get codes over a cap), which the owner accepted. The
  per-address counter stores a keyed digest of the address (`SUAS_SESSION_SECRET`), not the address.

- Any request whose path holds a `%` and, lower-cased and decoded until stable (at most 3 rounds), starts with
  `/api/v0/auth` or `/app/auth` answers `404` before routing (for example `/api/v0/auth/%63hallenges`,
  `/api/v0/auth%2Fchallenges` or `/api/v0/auth/%2563hallenges`), so no path variant skips the API Gateway route
  throttle.
- VA confirmation and the licence review stay fixture-only: a non-fixture account gets
  `503 ID_VERIFICATION_UNAVAILABLE` from `POST /api/v0/veterans/me/verification/va/confirm`, the VA sandbox OAuth
  routes, and `GET`/`POST /api/v0/veterans/me/verification/licence` and its `commands/dispute`. On the licence
  uploads the refusal comes before the body is read. Self-attestation still works.
- The email relay opens its allowlist only with both `SUAS_PUBLIC_DEMO=enabled` and `SUAS_ENV=STAGING`; the
  `publicDemo` context sets both on it.
- Real email addresses are then stored in the STAGING database. Retention (R16.5(b), contributor proposal, not
  released): the job worker's `staging_demo_retention` sweep runs on every STAGING pass (each minute) and scrubs every
  account that is not a registered fixture principal and was created more than 7 days ago. With the demo off it
  scrubs every such account at once, whatever its age. For each account, in one transaction, it:
  - records a `DELETION_REQUEST` Audit Event (`fulfillment: STAGING_DEMO_RETENTION`, no address);
  - soft-deletes the user (status `REVOKED`), which releases its VA and licence identifiers, and revokes its sessions;
  - clears `users.email`, `phone` and `display_name`, deletes its sign-in challenges, clears the destination of its
    notifications, and marks trusted contacts it owns, joined or was invited to as `REMOVED` with a placeholder
    invite address.

  It also deletes challenges with no account (refused or over-cap sign-ups) older than 7 days and rate-limit windows
  older than 2 days. Audit, Domain and consent events are kept. It logs counts only
  (`msg: staging_demo_retention`, `scrubbed`, `challenges_deleted`), never an address. A scrubbed account is never
  selected again, so repeated runs do nothing. The fixture seed's SUSPENDED publisher account is kept, although it is
  not in the registry. A wrong registry would scrub every other account, so check the registry first.
  With an empty registry the sweep scrubs no account and logs `msg: staging_demo_retention_skipped` each pass; it still deletes old orphan sign-in codes and rate-limit windows. Startup refuses `SUAS_PUBLIC_DEMO=enabled` on STAGING while the registry is empty.
  Known gaps: consent grants owned by a scrubbed account stay `ACTIVE` (the account cannot sign in), and the
  15-minute issue and verify limits keep the address in plain text until the `rate_limit_prune` sweep removes them.

## Note

Plus-addressed codes need the STAGING email provider (Resend through the email relay, suas #305) to be
configured; with email disabled no code is sent to any address.
