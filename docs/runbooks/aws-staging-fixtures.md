# AWS STAGING fixture users and Resources

Contributor proposal R11.5 (suas-specs #75, not released). Applies to the AWS CDK staging in `infra/` only.
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

It does not mark anyone ID-verified. VETERAN_VERIFICATION.md §1.1 (0.8.0) says a fake check cannot satisfy the
request gate in STAGING, so seeded users can help others but cannot request help until a real gate exists. It
seeds no SUAS admin.

## Fixture addresses and sign-in codes (R11.7)

Contributor proposal R11.7 (specs #75, not released). Sign-in on STAGING is an emailed code, and a synthetic
address (`@example.invalid`) never receives mail. So a fixture address may also be a plus address of the one real
mailbox stored in `/suas/staging/fixture-mailbox`:

- Address form `<local>+<tag>@<domain>`, where `<local>@<domain>` is the mailbox (case does not matter) and the
  tag is 1-32 of `a-z`, `0-9`, `-`.
- Pick one tag per fixture and say what it is for, for example `vet1`, `vet2`, `helper1`. Each tag is a separate
  SUAS user; two fixtures cannot share one address.
- Gmail delivers every plus address to the mailbox, so all fixture codes arrive in the owner's inbox, addressed
  to the tagged form. Sign in on the web app with the tagged address and read the code there.
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

## Note

Plus-addressed codes need the STAGING email provider (R11.2, Gmail SMTP) to be configured; with email disabled no
code is sent to any address.
