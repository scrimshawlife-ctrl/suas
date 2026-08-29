# Operational authorization record — 2026-08-29

**Authority:** Executive/Product accountability recorded from the 2026-08-29 decision.

**Scope:** Pilot implementation and synthetic-STAGING evidence only. This record does not authorize production deployment, real-world fulfillment, provider activation, use of non-synthetic STAGING data, destructive purge, or an advance to any readiness gate.

## Recorded decision states

```text
D-007_POLICY: APPROVED_WITH_OPERATIONAL_GATES
D-007_EXPORT_RELEASE: BLOCKED_PENDING_NAMED_PRIVACY_OWNER
D-007_365_DAY_PURGE: DRY_RUN_AUTHORIZED
D-007_DESTRUCTIVE_PURGE: NOT_AUTHORIZED
D-025_POLICY: APPROVED
D-025_INTERNAL_THRESHOLD: K_10
D-025_PARTNER_PUBLIC_THRESHOLD: K_20
D-025_REPORTING_RELEASE: BLOCKED_PENDING_IMPLEMENTATION_EVIDENCE
CANONICAL_DOMAIN: SUAS_HELP_CONDITIONAL
RESEND_ACTIVATION: SYNTHETIC_STAGING_ONLY
REAL_WORLD_EFFECTS: NOT_AUTHORIZED
PARTICIPANT_DIRECTED_REFERRAL: PILOT_GATED
AUTONOMOUS_FULFILLMENT: NOT_AUTHORIZED
PILOT_GATE: APPROVED
PILOT_LAUNCH: NOT_AUTHORIZED
PRODUCTION_LAUNCH: NOT_AUTHORIZED
EXECUTIVE_LAUNCH_OWNER: DANIEL
BACKUP_LAUNCH_OWNER: NOT_COMPUTABLE
```

## D-007 data operations

- Export packages are asynchronous, encrypted at rest and in transit, and may be delivered only through a 24-hour authenticated, single-use link after reauthentication. Email may contain only a neutral notification and link, never the export or sensitive content.
- Record request creation, verification, authorization, access, expiration, revocation, deletion, affected systems, exceptions, and provider outcomes.
- Provider deletion outcomes are limited to `DELETED_CONFIRMED`, `DELETION_REQUESTED`, `BACKUP_EXPIRY_PENDING`, `LEGAL_RETENTION_APPLIES`, `PROVIDER_LIMITATION_DOCUMENTED`, `NOT_HELD_BY_PROVIDER`, and `FAILED_REQUIRES_ESCALATION`. SUAS must not claim complete erasure without a provider confirmation.
- Identifiable case data becomes eligible for purge 365 days after case closure or last participant activity, whichever occurs later. Exclusions are open cases, legal holds, unresolved safety or security incidents, active provider or payment disputes, incomplete export or deletion requests, and documented statutory retention obligations.
- Dry-run reporting is authorized for synthetic STAGING. A synthetic destructive purge plus restoration test requires the documented exclusions and Privacy and Legal approval before it may be executed. Enforcement remains blocked until the pilot launch gate passes.
- Before operational release, name a Privacy Lead, trained Privacy Administrator, Legal/Compliance approver, platform deletion executor, and backup executor. Daniel holds Executive/Product accountability and is not the sole Privacy or Legal reviewer.

## D-025 minimum aggregate reporting policy

The first projection may contain only fixed week or month periods, county or broader geography, resource category, requests initiated, completed, and unfulfilled, completion-rate percentage, wait-time band, provider category, broad referral source, and broad closure reason.

It excludes names, contact information, exact locations, case identifiers, free-text narratives, document information, exact dates or timestamps, individual provider interactions, demographic cross-tabulation, safety-event details, and unapproved sensitive-status detail.

- Internal cells require `k >= 10`.
- Partner and public cells require `k >= 20`.
- Complementary suppression applies where a suppressed cell could otherwise be reconstructed.
- Reports use fixed time and geography buckets. Partner and public users receive no arbitrary interactive filtering, suppressed-denominator percentages, or repeated-query paths that permit subtraction.

Reporting remains disabled until canonical metric definitions, projection-boundary tests, complementary-suppression tests, access roles, export auditing, retention, rendered-report Privacy and Safety review, and log/analytics/URL/download leakage checks are accepted. Release order is internal fixed dashboard, partner precomputed reports, then public monthly reports.

## Domain, providers, and effects

`suas.help` is conditionally selected, pending registration, organizational control, trademark review, DNS, SPF, DKIM, DMARC, Resend verification, and mailbox ownership. No identity configuration is authorized until ownership is confirmed. If it is unavailable, use a controlled organizational pilot subdomain rather than an improvised look-alike.

Provider activation stays synthetic-STAGING-only, with separate credentials, verified staging sender, signed and idempotent webhook evidence, synthetic delivery-state cases, alerts to named primary and backup humans, key lifecycle drills, and fail-closed configuration. No general real-world fulfillment is authorized. Participant-directed referrals remain pilot-gated and consent-led. Capability-specific controls default to false.

## Launch authority

The pilot gate is approved, but launch is not. Required launch evidence includes named primary and backup owners, consent and notices, provider contracts and data inventory, monitoring and tested alerts, on-call, incident tabletop, recovery proof, deletion/export drill, security, Privacy, and Safety review, and all unapproved real-effects capabilities disabled. Production remains a separate future decision after controlled pilot evidence.
