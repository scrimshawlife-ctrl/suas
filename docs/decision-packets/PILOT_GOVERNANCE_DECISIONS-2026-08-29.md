# Pilot governance decisions — 2026-08-29

**Status:** APPROVED_FOR_PILOT_IMPLEMENTATION

The Executive Launch Owner has approved this decision set for pilot implementation with role placeholders. It does not authorize production, real provider effects, use of non-synthetic data in STAGING, or a change to any formal readiness verdict. A canonical SUAS domain and named primary/backup humans remain required before production activation or final launch.

## D-007 data operations

- **Accountability:** Privacy Lead approves routine deletion. Privacy Operations or a trained administrator executes requests; Platform Operations executes technical work. Retention exceptions require Privacy and Legal/Compliance approval. Legal holds record authority, scope, start, and review date. Emergency security holds require Privacy review within one business day.
- **Verification and timing:** Existing verified account channels are the default reauthentication path. Unauthenticated requests use a one-time link to a previously verified destination; identity mismatches and sensitive exports require manual review. Acknowledge requests within five business days and complete within 30 calendar days unless law requires sooner.
- **Deletion coverage:** Active and derived records, search indexes, caches, attachments, durable jobs, and covered downstream processors are included. Provider deletion capability and limitations must be documented. Immutable backups may expire on their documented schedule but deleted data must not be restored to active use. Recipient-controlled copies, including inboxes, are out of scope.
- **Export:** Produce an encrypted ZIP containing canonical JSON, human-readable CSV, manifest, schema version, UTC timestamps, provenance, and SHA-256 checksums. Deliver by authenticated single-use link expiring in 24 hours. Never put sensitive personal information in email bodies.
- **Evidence:** Record request ID, verifier, authorizer, affected systems, provider receipts, exceptions, completion time, and requester notification.

## Pilot service objectives and recovery

| Measure                       | Pilot objective |
| ----------------------------- | --------------- |
| System-of-record availability | 99.5% monthly   |
| Successful reads p95          | <= 1,000 ms     |
| Successful writes p95         | <= 1,500 ms     |
| Server error rate             | <1% over 15 min |
| Durable-job acknowledgement   | >=99.9%         |
| Job start latency p95         | <=2 min         |
| Ordinary job completion p99   | <=15 min        |
| Acknowledged job loss         | zero tolerated  |
| System-of-record RTO / RPO    | 4 h / 24 h      |
| Durable-job RTO / RPO         | 4 h / 1 h       |

Page immediately for loss of acknowledged jobs, backup/replication/integrity failure, or safety-message failure. Production on-call is also paged when system-of-record unavailability lasts five minutes, errors exceed 5% for five minutes, the oldest ready job exceeds five minutes, authentication failures exceed 3x the seven-day baseline for ten minutes, or critical email delivery failure exceeds 1% for ten minutes. Pilot requires monthly sampled restores and quarterly recovery exercises.

## Pilot identity and access

- Staff MFA is required through TOTP or passkey. Staff inactivity/absolute lifetimes are 30 minutes/12 hours; participant lifetimes are 60 minutes/24 hours; privileged credentials last 15 minutes.
- Participant magic links are single-use and expire after 15 minutes. Failed authentication is limited to five attempts per 15 minutes. Magic-link issuance is limited to three per account and ten per IP per 15 minutes.
- General authenticated API traffic is limited to 60 requests/min/user. Sensitive submissions are limited to five/hour/identity and 20/hour/IP. Sensitive exports are limited to three/day/user. Admin mutations are limited to 30/min/user.
- Rate limits must not reveal account existence. Refresh credentials rotate and revoke on password, MFA, role, or security-state changes. Staff and service accounts use separate identities, shared administrator accounts are prohibited, privileged actions need recent authentication and immutable audit records, and safety-critical submissions need a documented alternative channel.

## Resend boundary

The canonical domain is unresolved. Keep `SUAS_EMAIL_MODE` non-production and external effects disabled. When the canonical domain is approved, use a dedicated `notify.<canonical-domain>` sender subdomain, a minimally descriptive from address, deployment-secret-manager storage, distinct staging/pilot/production keys, 90-day rotation, MFA, and least privilege. Verify signed, idempotent, replay-protected webhook handling with timestamp-aware ordering. Monitor sent, delivered, delayed, failed, bounced, complained, and suppressed events. Provider activation requires named ownership and a synthetic STAGING acceptance path first.

## Sensitive reporting

Reporting remains disabled until the approved minimum projection is implemented. Internal aggregate cells require k >= 10; partner and public cells require k >= 20, with complementary suppression and resistance to differencing attacks. Deidentify or pseudonymize analyst datasets, coarsen identifying dimensions, exclude free text and precise safety data, and audit every export. Default retention: temporary exports 7 days (30-day maximum), event-level datasets 90 days, approved deidentified aggregates 13 months, and reporting access logs 24 months.

## Environment and launch boundary

STAGING remains synthetic-only. Pilot requires separate projects/accounts, databases, storage, queues, domains, webhook endpoints, credentials, encryption keys, and analytics destinations. CI and test runners must not receive pilot/production credentials or artifacts. Pilot launch requires named owners, consent/notices, provider contracts, monitoring, on-call, incident tabletop, recovery proof, privacy and safety review. Production requires successful pilot completion, final launch approval, and all production-specific evidence.
