# Backup-restore exercise plan

**Precondition:** attributable approval that identifies the exact approved backup and isolated restoration target. No restoration may begin without it.

## Approval-controlled inputs

| Field | Required value |
| --- | --- |
| Source STAGING environment | `[positively identified STAGING source required]` |
| Backup identifier and creation time UTC | `[required]` |
| Isolated target database/project identity | `[required, separate from active STAGING]` |
| Expected schema version and migration head | `[required]` |
| Exercise owner and approver | `[required]` |
| Evidence location | `docs/readiness/evidence/synthetic-staging-2026-08-29/recovery/` |

## Execution plan after approval

1. Run the invariant guard and record a UTC start event plus monotonic elapsed timer.
2. Confirm target has no pilot/production connectivity, no real provider credentials, no real outbound effects, synthetic-only data, paused workers, and disabled notifications.
3. Restore only the approved backup to the isolated target. Never overwrite or restore into active STAGING.
4. Record database-reachable, schema-validation-complete, and application-check-complete UTC events.
5. Compare tables, columns/types, constraints, indexes, RLS/policies, functions/RPCs, triggers, and migration history against the approved canonical schema.
6. Run deterministic fixture-count, foreign-key, uniqueness, audit-continuity, provenance, and pilot/production-data absence checks.
7. Verify approved synthetic durable-job fixtures: queued discovery, expired lease recovery, safe retryability, terminal completed jobs, idempotency, retry counters, dead letters, paused workers, synthetic-only effects after explicit release, and zero acknowledged-job loss.
8. Calculate restoration duration, total verified duration, backup age, demonstrated loss boundary, RTO result, and RPO result. Missing inputs yield `NOT_COMPUTABLE`.
9. Abort on schema divergence without approved explanation, acknowledged-job loss, completed-job replay, external effect, pilot/production data, secret leakage, missing loss boundary, or missing RTO/RPO evidence.
10. Preserve the target until evidence review or explicit teardown approval. Escalate failure through the named owner and incident route.

## Completion definition

Recovery completes only when the isolated target is reachable, the canonical schema comparison and deterministic integrity checks pass, durable-job recovery checks pass, application smoke checks pass, and calculated RTO/RPO evidence is recorded without sensitive values.
