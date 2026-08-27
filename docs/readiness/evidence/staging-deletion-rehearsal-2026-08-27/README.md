# STAGING deletion rehearsal — 2026-08-27

**Environment:** synthetic Neon via unpooled `DATABASE_URL`, `SUAS_ENV=STAGING`  
**Policy (D-007):** soft-delete operational rows; retain events **365 days**  
**Command:** `SUAS_ENV=STAGING npm run privacy:deletion-drill`  
**Report:** `report.json` (opaque UUIDs only; no contact destinations)

## Result

| Field | Value |
| --- | --- |
| status | `ok` |
| privacy_gate | `NOT_READY` (purge/export package + broader sign-off remain) |
| d007 | `SOFT_DELETE_RETAIN_EVENTS_365D` |
| fulfillment | `SOFT_DELETE_OPERATIONAL_ROW` |
| sessions_revoked | ≥ 1 |
| history retained | domain + audit + consent events |

## Claim boundary

- Not PRODUCTION. No HIPAA claim. Provider-side copies `NOT_COMPUTABLE`.
- Drill creates its own synthetic subject; does not target seeded demo accounts.
- Automatic purge after 365 days is **not** implemented in this rehearsal.
