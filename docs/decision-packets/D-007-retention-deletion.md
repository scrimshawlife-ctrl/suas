# Decision packet — D-007 retention / deletion

**Status:** DECIDED for STAGING (2026-08-27)  
**Affects gates:** `PRIVACY`  
**Blocks:** Formal PRIVACY READY (purge/export package + human sign-off may still remain)

## Exact question

What retention and deletion durations apply after a deletion request, and what may be purged vs retained?

## Decision (2026-08-27) — STAGING synthetic policy

1. **Operational rows:** soft-delete (status → `REVOKED`); do not hard-delete the user row.
2. **Sessions:** revoke all for the subject.
3. **Domain Events, Audit Events, consent history:** **retain for 365 days**.
4. **Provider-side copies:** `NOT_COMPUTABLE` (no erase claim).
5. **HIPAA:** no claim.
6. **PRODUCTION** purge/export package: still deferred (SPEC-018 / separate owner authorization).

## Released constraints

- PRIVACY.md §2, §9, §10 — deletion is documented; events/audit not silently destroyed.
- CONSENT.md §4 — consent history survives.
- AUTH.md §5 — REVOKED invalidates sessions.
- ENVIRONMENT.md §2/§5 — synthetic-only for drills; refuse PRODUCTION / prod URL markers.

## Work completed

- Synthetic deletion drill (`src/privacy/deletion-drill.ts`, `npm run privacy:deletion-drill`)
- STAGING Neon rehearsal evidence under `docs/readiness/evidence/`
