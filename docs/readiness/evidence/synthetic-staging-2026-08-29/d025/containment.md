# D-025 reporting containment and negative evidence

```text
D025_REPORTING=disabled
D025_REPORTING_RELEASE=BLOCKED
```

## Committed implementation evidence

- `src/reporting/projection.ts` exposes a pure projection with `IMPLEMENTED_DISABLED_PENDING_EVIDENCE` release state.
- `wrangler.jsonc` keeps sensitive aggregate reporting disabled.
- Configuration validation rejects enabled sensitive aggregate reporting pending D-025 release evidence.
- Projection behavior encodes internal `k=10` and partner/public `k=20` thresholds and complementary suppression. The requested k=9/k=19 denial and k=10/k=20 allow cases must be retained as local test evidence only, not released reporting.

## Unfinished evidence categories

| Category | Verdict | Missing evidence |
| --- | --- | --- |
| Access | BLOCKED | Full role, direct-route, cross-tenant, and revocation runtime matrix requires authorized credentials. |
| Audit | NOT_COMPUTABLE | No approved reporting attempts exist while release is disabled. |
| Retention | BLOCKED | No report artifact may be generated. Classification, expiry, dry run, receipt, and backup-boundary proof are incomplete. |
| Review | BLOCKED | Privacy, Safety, partner/public release, metric-definition, and rendered-output review records are absent. |
| Threshold/suppression | PASS (local implementation only) | Unit tests validate projection mechanics. This is not release authorization. |

No scheduled report, report email, report download, analytics delivery, or report artifact was generated. Reporting remains disabled even if future categories pass, pending explicit owner re-settlement.
