# D-007 synthetic aggregate-only dry-run execution contract v1.0.0

## Allowed operation

- Evaluate only `synthetic-dataset-v1.json` with `src/privacy/retention-dry-run.ts` at the approved exact UTC cutoff.
- Produce only the schema in `aggregate-output-contract-v1.json`.
- Run twice against unchanged input for an idempotency comparison.

## Mandatory prohibitions

- Read-only fixture input. No database connection or mutation.
- No deletion command, deletion job, purge scheduler, or deletion receipt.
- No export generation, download link, email, SMS, notification, or provider call.
- No row-level output, credentials, real data, or real-world effect.
- `D007_DELETION_EXECUTION`, `D007_EXPORT_DELIVERY`, `D007_365_DAY_PURGE`, and `D025_REPORTING` remain disabled. Pilot and production remain blocked.

## Preconditions

1. The final owner record selects `ACCEPT`, supplies a full accountable name, and contains an owner-supplied UTC signing timestamp.
2. Every referenced file hash matches the authorization record.
3. The execution code is exactly commit `31303cd` and the static invariant passes immediately before and after execution.
4. A verified synthetic-STAGING deployment identifier remains required for any deployed execution. Its absence blocks deployed execution.

This contract itself confers no authority and is not an execution instruction until a complete owner record exists.
