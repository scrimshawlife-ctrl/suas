# Incident-response runbook (tabletop)

## Severity classes (working)

| Class | Example                           | First action                                                                 |
| ----- | --------------------------------- | ---------------------------------------------------------------------------- |
| S1    | Suspected cross-tenant disclosure | Disable affected routes / take STAGING offline; preserve logs; open incident |
| S2    | Auth challenge abuse / mail bomb  | Confirm rate-limit 429s; tighten inferred limits only via released change    |
| S3    | Job/scoring skipped or degraded   | Check `SUAS_SUPPORT_SIGNAL_MODE`, health.job_queue, recent deploy            |

## Immediate checklist

1. Stop real external effects (`SUAS_ALLOW_REAL_EXTERNAL_EFFECTS` must already be false outside authorized prod).
2. Capture `x-request-id`, build provenance, migration status — no secrets in tickets.
3. Revoke sessions if credential compromise suspected (`POST /api/v0/auth/sessions/commands/logout` + admin user status).
4. Do **not** invent crisis wording; D-012 approved copy only when mode=`approved`.
5. No automated emergency dispatch — ever.

## Tabletop evidence

Synthetic drills live in `tests/integration/resilience-drills.test.ts` (duplicate command, outbox crash, notification unavailable, concurrent settlement, bounded queues). Re-run:  
`npx vitest run tests/integration/resilience-drills.test.ts`

## Post-incident

Update gate matrix residuals; open decision packet if a vendor/SLO gap was the root cause.
