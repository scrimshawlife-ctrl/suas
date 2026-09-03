# SPEC-017 slice record: fixed-profile synthetic-STAGING soak harness

## Released references

- Stack `0.2.0`, `RELEASE_MANIFEST-0.2.0.md`, authority `RELEASED_FOR_IMPLEMENTATION`.
- `ENVIRONMENT.md` §2 and §5: STAGING is synthetic-only and configuration fails closed.
- `TESTING.md` §11: deployed-boundary readiness evidence.
- `API.md`: bearer-only `/api/v0` and bounded read routes.
- Campaign constraint: `docs/readiness/evidence/synthetic-staging-2026-08-29/soak/status.md`.

## Changed files and behavior

- `scripts/synthetic-staging-soak.ts`: fixed GET-only route mix, canonical
  5-minute warm-up + 5 VUs/120 minutes + 10 VUs/15 minutes + up-to-15-minute
  drain, shorter-duration test overrides, fail-closed safety locks, sanitized
  aggregate output, and bounded GET retries for transient staging `503`/`500`
  before recording the observation. Retry counts are aggregate-only; this is
  not a capacity SLO.
- `.github/workflows/synthetic-staging-soak.yml`: manual dispatch only, existing
  synthetic E2E origin and bearer secrets, no provisioning or deployment.
- `tests/unit/synthetic-staging-soak.test.ts`: profile, safety, secret/body
  redaction, route/method, aggregation, and workflow invariants.
- `README.md` and `package.json`: operator documentation and command registration.

## Environment, migration, and client impact

- New command-only environment inputs are documented in the workflow. No runtime
  application configuration, `/api/v0` contract, auth behavior, migration, or
  schema changed.
- iOS and Android require no change because the API and Veteran journey are
  unchanged.

## Safety, privacy, and unavailable boundaries

- Deletion, export delivery, 365-day purge, sensitive reporting, real-world
  effects, pilot launch, and production launch must remain disabled or blocked.
- Only aggregate timings, statuses, request IDs, and sanitized error categories
  are persisted. Credentials, headers, bodies, and raw errors are excluded.
- No real provider adapter, external mutation, report release, production
  capacity claim, or production-readiness claim is introduced.

## Execution status

The soak was not provisioned or run by this slice. Only static and unit
validation of the harness and workflow is permitted for this implementation task.

## Semantic gaps

None introduced. Queue, retry, dead-letter, restart, connection, and alert
observability remain separate owner-authorized campaign evidence rather than
being invented by this request-only harness.

## Follow-up: main soak 33688841766

Failed canonical soak on `fad50fb` after PR #168 was staging `503` flake (plus
two `500`s on `responder_unassigned_cases`), not a session-minting or product
bug. Session refresh succeeded; health stayed `200`; no `401`. The harness now
retries those GET statuses before recording so a transient platform 5xx is not
a false red. Persistent 5xx still fail the run. SPEC-017 stays `NOT READY`.
