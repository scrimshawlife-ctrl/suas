# D-007 synthetic aggregate-only dry-run approval request

**Status:** incomplete request scaffold. It is **not signable** until the Privacy owner supplies or approves the identified synthetic dataset, exact mapping, and cutoff. These facts are intentionally not invented.

| Required approval field | Value required before signing |
| --- | --- |
| Decision ID | `D-007` |
| Approver human name | `[required]` |
| Accountable role | `Privacy owner` |
| Approval timestamp (UTC) | `[required]` |
| Repository commit SHA evaluated | `[required after owner selects approved commit]` |
| Synthetic dataset identifier and SHA-256 | `NOT_PROVIDED` |
| Input-mapping identifier and SHA-256 | `NOT_PROVIDED` |
| Exact UTC cutoff | `NOT_PROPOSED` |
| Approved output fields | aggregate entity totals; eligible/excluded totals by rule; already-deleted synthetic totals; provider-class totals; backup-expiry-pending totals; legal-hold fixture totals; validation-failure totals; duration; mapping hash; cutoff; dataset hash; code/deployment SHA |

## Required owner attestation

> I approve the identified synthetic input mapping, exact UTC cutoff, and target synthetic dataset for this aggregate-only D-007 dry run. The run may not mutate data, create deletion commands, create export payloads or links, notify anyone, call external deletion APIs, or expose row-level identifiers. Deletion execution and export delivery remain disabled.

- Signature or repository-native authenticated approval reference: `[required]`
- Signed at (UTC): `[required]`

Once complete, attach this record under `approvals/` without credentials or row-level data, then rerun the preflight invariant before the dry run.
