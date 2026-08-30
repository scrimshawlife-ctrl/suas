# Recovery exercise status

```text
RECOVERY_EXERCISE=BLOCKED
reason=MISSING_AUTHENTICATED_NEON_RESTORE_CAPABILITY
```

The continuation work authorizes a synthetic-STAGING recovery exercise, but the current integrated tool boundary has no authenticated Neon capability for creating an isolated restore target, selecting a backup or recovery point, executing the restore, or reading sanitized status and timing.

No backup was restored. No isolated target was created or torn down, and no database credential was exposed. The available migration rehearsal is explicitly not recovery evidence and does not demonstrate backup age, loss boundary, RTO, RPO, authoritative-session recovery, or durable-job recovery.
