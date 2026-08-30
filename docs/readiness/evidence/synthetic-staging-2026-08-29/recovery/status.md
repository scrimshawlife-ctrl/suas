# Recovery exercise status

```text
RECOVERY_EXERCISE=PARTIAL
source_project=suas-synthetic-staging
target_branch=recovery-drill-20260830
target_state=READY_AND_PRESERVED
production_effects=NONE
```

## Authorization and isolation

The owner approved an immediate synthetic-STAGING snapshot drill after read-only inspection established that the source branch had no prior snapshots and no automatic snapshot schedule. The drill used the independently owned `suas-synthetic-staging` Neon project and created a new non-default, non-primary branch named `recovery-drill-20260830`. Active synthetic STAGING was not overwritten, renamed, or rebound. No database connection string, password, session credential, OTP, provider key, or row-level personal data was retrieved.

The restored target remains preserved for evidence review as required by the exercise plan. It has no Worker, Hyperdrive, provider, notification, pilot, or production binding.

## Observed timeline

| Event | UTC |
| --- | --- |
| Exercise timer started | `2026-08-30T16:58:24.444Z` |
| Manual source snapshot created | `2026-08-30T16:58:30Z` |
| Isolated restore requested | `2026-08-30T16:58:36Z` |
| Isolated branch ready | `2026-08-30T16:58:37Z` |
| Aggregate database validation complete | `2026-08-30T16:59:04Z` |
| Schema comparison and integrity checks complete | `2026-08-30T16:59:35Z` |

Observed measurements:

- branch-ready restore duration: **7 seconds** from snapshot creation, or approximately **1 second** from restore request;
- database aggregate-validation duration: **39.556 seconds** from exercise start;
- schema-validation duration: **70.556 seconds** from exercise start;
- snapshot age at restore request: approximately **6 seconds**;
- snapshot source timestamp: `2026-08-30T16:57:10Z`;
- demonstrated source-to-snapshot loss boundary: **80 seconds**.

These are one synthetic-STAGING observation, not production guarantees or an SLO claim.

## Restored-state observations

The isolated branch reported `restore_status=restored`, `current_state=ready`, and remained non-default and non-primary. A schema comparison against active synthetic STAGING returned an empty diff.

Aggregate-only validation observed:

| Invariant | Observation |
| --- | ---: |
| Public base tables | 45 |
| Applied migrations | 14 |
| Migration head | 14 |
| Synthetic users | 5 |
| User tenant count | 1 |
| Authoritative sessions | 36 |
| Authentication challenges | 9 |
| Durable `job_outbox` rows | 0 |
| Event outbox rows | 8 |
| Audit events | 48 |
| Foreign keys | 65 |
| Public indexes | 147 |
| Public triggers | 13 |
| RLS policies | 0 |

The single observed user tenant is consistent with the canonical synthetic tenant boundary. Session and browser-auth persistence were present in the restored database. Audit and event-outbox continuity were present. No raw identity, destination, credential, event payload, or session value was read.

## Computability and remaining closure

```text
RESTORE_EXECUTION=PASS
SCHEMA_COMPARISON=PASS
TENANT_PRESENCE=PASS
SESSION_PRESENCE=PASS
AUTH_ENROLLMENT_STATE=PRESENT_BY_AGGREGATE
AUDIT_CONTINUITY=PRESENT_BY_AGGREGATE
DURABLE_JOB_RECOVERY=NOT_COMPUTABLE_NO_FIXTURES
APPLICATION_SMOKE=NOT_RUN_NO_ISOLATED_RUNTIME_BINDING
RTO_OBSERVATION=7_SECONDS_TO_BRANCH_READY
RPO_OBSERVATION=80_SECONDS_SOURCE_TO_SNAPSHOT
PRODUCTION_RTO_RPO=NOT_COMPUTABLE
```

The drill materially closes the prior authenticated-restore blocker and proves that a Neon snapshot can be restored into an isolated, ready branch with a schema identical to active synthetic STAGING. It does **not** close the full recovery exit condition because the source snapshot contained no durable-job fixtures and no isolated application runtime was bound to the restored target. Durable-job replay/loss behavior and end-user application smoke therefore remain unobserved rather than inferred.

The target must remain preserved until explicit teardown approval. A later drill should seed approved queued, leased, completed, retrying, and dead-letter synthetic job fixtures before snapshot creation and attach an effects-disabled isolated runtime for application smoke testing.
