# Preflight readiness matrix

Hygiene record. Not a SPEC-018 evidence pack. Not a readiness-gate change.

```text
SPEC_STACK = 0.6.0
SPEC_018 = KEEP_BLOCKED
PILOT_READINESS = NOT_READY
PRODUCTION_READINESS = NOT_READY
REAL_VETERAN_DATA = PROHIBITED
REAL_EXTERNAL_EFFECTS = PROHIBITED
STORE_DISTRIBUTION = PROHIBITED
PRODUCTION_AUTHORITY_CHANGED = false
```

Allowed statuses: `PASS`, `FAIL`, `PARTIAL`, `BLOCKED_BY_DECISION`, `BLOCKED_BY_COUNSEL`, `OPERATOR_ACTION_REQUIRED`, `NOT_COMPUTABLE`.

`READY` is not used.

| DOMAIN              | CONTROL                   | SPEC_SOURCE                                                                 | IMPLEMENTATION_REPO            | STATUS                   | EVIDENCE                                                                        | BLOCKER                                                                                                          | OWNER       | NEXT_ACTION                                                                   |
| ------------------- | ------------------------- | --------------------------------------------------------------------------- | ------------------------------ | ------------------------ | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------- |
| Governance          | main branch protection    | AGENTS.md repository boundary                                               | suas                           | PARTIAL                  | docs/hardening/BRANCH_PROTECTION.md                                             | Applied 2026-09-30: PR, `verify`, conversation resolution, no force-push, no deletion. `enforce_admins` is false | operator    | Decide whether admins may bypass                                              |
| Governance          | main branch protection    | MOBILE_SURFACE.md                                                           | suas-ios                       | OPERATOR_ACTION_REQUIRED | suas-ios docs/GOVERNANCE.md                                                     | Private repo returned HTTP 403 (GitHub Pro or public). Protection was not applied                                | operator    | Upgrade plan or make protection available, then require `contract` and `unit` |
| Governance          | main branch protection    | MOBILE_SURFACE.md                                                           | suas-android                   | PARTIAL                  | suas-android docs/GOVERNANCE.md                                                 | Applied 2026-09-30: PR, conversation resolution, no force-push, no deletion. No required status check yet        | operator    | After `contract` has run on main, require that check                          |
| Governance          | main branch protection    | AGENTS.md                                                                   | suas-specs                     | PARTIAL                  | API applied 2026-09-30: PR, conversation resolution, no force-push, no deletion | No always-on required check, because skills-validate is path-filtered                                            | operator    | Add a required check only if an always-on workflow exists                     |
| Release             | spec pin 0.6.0            | RELEASE_MANIFEST-0.6.0.md                                                   | suas                           | PASS                     | verify workflow sets SUAS_SPEC_VERSION                                          | none for the pin check                                                                                           | engineering | Keep the pin                                                                  |
| Queue               | production durable queue  | D-022 packet DECIDED Postgres outbox; operator call ACCEPT_LOCAL_FAKE_QUEUE | suas                           | PARTIAL                  | src/jobs/factory.ts selects the Postgres outbox for STAGING and PRODUCTION      | Operator call 2026-09-25 forbids claiming PRODUCTION_DURABLE_QUEUE READY. SPEC-018 stays KEEP_BLOCKED            | operator    | Keep the selected factory path. Do not authorize a production launch          |
| Idempotency         | persistent command replay | API.md §7                                                                   | suas                           | PASS                     | tests/integration/idempotency.test.ts                                           | none observed in this audit                                                                                      | engineering | Keep the suite                                                                |
| Idempotency         | logical key reuse         | MOBILE_SURFACE.md §4.4                                                      | suas-ios                       | PARTIAL                  | suasTests idempotency and transport retry                                       | Device retry of a real timeout is not recorded                                                                   | engineering | Keep keys in OperationIdentity                                                |
| Idempotency         | logical key reuse         | MOBILE_SURFACE.md §4.4                                                      | suas-android                   | PARTIAL                  | ContractTest retry cases                                                        | Device retry is not recorded                                                                                     | engineering | Keep SubmissionAttempt                                                        |
| Mobile              | environment fail-closed   | MOBILE_SURFACE.md §8                                                        | suas-ios, suas-android         | PARTIAL                  | Client configuration tests                                                      | No production host exists, by decision                                                                           | engineering | Reject PRODUCTION                                                             |
| Mobile              | forbidden capabilities    | MOBILE_SURFACE.md §5                                                        | suas-ios, suas-android         | PARTIAL                  | scripts/forbidden-capabilities.sh                                               | Static scan is incomplete for reflection and binaries                                                            | engineering | Keep the scan in CI                                                           |
| Mobile              | crisis offline            | SAFETY_COPY.md §0–§1.1, MOBILE_SURFACE.md §6.6                              | suas-ios, suas-android         | PARTIAL                  | Local CrisisCopy constants                                                      | Wording match is by test of the constants, not a screenshot                                                      | engineering | Do not edit the released sentences                                            |
| Mobile              | application identity      | MOBILE_SURFACE.md §8                                                        | suas-ios                       | OPERATOR_ACTION_REQUIRED | Observed bundle id teletrex.suas                                                | Specs do not name a bundle id                                                                                    | operator    | Decide the identifier before any store step                                   |
| Mobile              | application identity      | MOBILE_SURFACE.md §8                                                        | suas-android                   | OPERATOR_ACTION_REQUIRED | applicationId com.example.suas labeled placeholder                              | Specs do not name an applicationId                                                                               | operator    | Decide the identifier. Do not invent one                                      |
| Privacy             | memory-only session       | D-034 ACCEPT_MEMORY_ONLY_DEFAULT                                            | suas-ios, suas-android         | PARTIAL                  | Session memory plus Android backup false                                        | Full on-device crypto remains open                                                                               | operator    | Do not add Keychain or Keystore persistence                                   |
| Auth                | production provider       | D-002 KEEP_PENDING                                                          | suas                           | BLOCKED_BY_DECISION      | AUTH.md                                                                         | Provider not selected                                                                                            | operator    | Do not select a provider in code                                              |
| Rate limit          | network throttling        | D-036 Option C                                                              | suas                           | PASS                     | Destination/account limits only. Network budget is not claimed                  | none                                                                                                             | operator    | Do not add a network budget                                                   |
| Recovery            | contractual RTO/RPO       | D-021/D-023/D-024 ACCEPT_NOT_COMPUTABLE                                     | suas                           | NOT_COMPUTABLE           | Existing recovery workflows are operator-gated                                  | No numeric target is authorized                                                                                  | operator    | Record observed durations later, separately from a target                     |
| Hosting             | production cloud          | D-001 KEEP_PENDING                                                          | suas                           | BLOCKED_BY_DECISION      | Worker topology is synthetic staging only                                       | Production host not chosen                                                                                       | operator    | Do not pick AWS, GCP, or a production Cloudflare account here                 |
| Legal               | HIPAA classification      | D-006 KEEP_PENDING                                                          | suas-specs D-006_FACT_SHEET.md | BLOCKED_BY_COUNSEL       | Fact sheet already exists                                                       | Counsel has not classified                                                                                       | counsel     | Do not write HIPAA applies or does not apply                                  |
| Pilot               | partner                   | D-008 KEEP_PENDING                                                          | suas-specs PILOT.md            | BLOCKED_BY_DECISION      | No partner values added                                                         | No released partner                                                                                              | operator    | Leave the checklist empty                                                     |
| Payment             | billing                   | D-010 KEEP_PENDING                                                          | suas                           | BLOCKED_BY_DECISION      | Shelter reservation stays blocked_by_payment_architecture                       | No card-free contract record                                                                                     | operator    | Do not collect card data                                                      |
| Compliance register | counsel review            | D-013 KEEP_PENDING                                                          | suas-specs COMPLIANCE.md       | BLOCKED_BY_COUNSEL       | Register exists                                                                 | Review not recorded                                                                                              | counsel     | Do not mark the register reviewed                                             |
| Accessibility       | WCAG 2.2 AA               | MOBILE_SURFACE.md §7 and §11.11                                             | suas-ios, suas-android         | NOT_COMPUTABLE           | docs/ACCESSIBILITY.md                                                           | Device pass not done                                                                                             | engineering | Manual check. Do not claim conformance                                        |
| Store               | distribution              | SPEC018_OWNER_LAUNCH_PACKET.md                                              | suas-ios, suas-android         | BLOCKED_BY_DECISION      | GOVERNANCE.md                                                                   | SPEC-018 KEEP_BLOCKED                                                                                            | operator    | Do not submit a binary                                                        |

## Workload and SLO worksheets

These names are parameters. They are not targets.

```text
pilot_veterans = NOT_COMPUTABLE
active_veteran_percentage = NOT_COMPUTABLE
requests_per_veteran_per_day = NOT_COMPUTABLE
responder_count = NOT_COMPUTABLE
peak_concurrency = NOT_COMPUTABLE
provider_request_ratio = NOT_COMPUTABLE
notification_ratio = NOT_COMPUTABLE
read_write_ratio = NOT_COMPUTABLE

OBSERVED:
  p95 latency = NOT_COMPUTABLE
  availability = NOT_COMPUTABLE
  restore duration = NOT_COMPUTABLE

CONTRACTUAL_TARGET:
  SLO = NOT_COMPUTABLE
  RTO = NOT_COMPUTABLE
  RPO = NOT_COMPUTABLE
```

## Pilot partner checklist

Every value is unset.

```text
organization_identity = NOT_COMPUTABLE
authorized_admin = NOT_COMPUTABLE
responder_roster = NOT_COMPUTABLE
escalation_contacts = NOT_COMPUTABLE
service_area = NOT_COMPUTABLE
support_categories = NOT_COMPUTABLE
operating_hours = NOT_COMPUTABLE
manual_fulfillment_contacts = NOT_COMPUTABLE
data_agreement_state = NOT_COMPUTABLE
training_completion = NOT_COMPUTABLE
incident_contact = NOT_COMPUTABLE
pilot_start = NOT_COMPUTABLE
pilot_end = NOT_COMPUTABLE
expected_participant_count = NOT_COMPUTABLE
```

## Counsel packet boundary

D-006_FACT_SHEET.md remains the counsel-facing product packet. This matrix adds no classification.

```text
HIPAA_APPLICABILITY = DECISION_PENDING
OBSERVED: native session is memory-only in the current clients
OBSERVED: Android backup is explicitly disabled in this change
INFERRED: none beyond the fact sheet
NOT_COMPUTABLE: whether HIPAA applies
```
