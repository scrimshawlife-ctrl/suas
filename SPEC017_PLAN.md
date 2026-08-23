# SPEC017_PLAN.md — Implementation conformance plan for SUAS v0.1.1

**Released spec:** `0.2.0` (plan opened against `0.1.1`; the runtime now pins `0.2.0` — `src/release/pins.ts`, `RELEASE_MANIFEST-0.2.0.md`)  
**Status:** `IN_PROGRESS`  
**Implementation repository:** `scrimshawlife-ctrl/SUAS`  
**Canonical specs:** `scrimshawlife-ctrl/SUAS-specs`

## Progress

| Slice                                   | Status                       | Record                                                                                         |
| --------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------- |
| 1 — Foundation                          | `IMPLEMENTED`                | [docs/slices/SLICE_01_FOUNDATION.md](docs/slices/SLICE_01_FOUNDATION.md)                       |
| 2 — Event/idempotency kernel            | `IMPLEMENTED`                | [docs/slices/SLICE_02_EVENT_IDEMPOTENCY.md](docs/slices/SLICE_02_EVENT_IDEMPOTENCY.md)         |
| 3 — Identity / tenancy / authorization  | `IMPLEMENTED`                | [docs/slices/SLICE_03_IDENTITY_TENANCY.md](docs/slices/SLICE_03_IDENTITY_TENANCY.md)           |
| 4 — Consent and privacy kernel          | `IMPLEMENTED`                | [docs/slices/SLICE_04_CONSENT_PRIVACY.md](docs/slices/SLICE_04_CONSENT_PRIVACY.md)             |
| 5 — Coordination kernel                 | `IMPLEMENTED`                | [docs/slices/SLICE_05_COORDINATION.md](docs/slices/SLICE_05_COORDINATION.md)                   |
| 6 — Follow-Up / Settlement              | `IMPLEMENTED`                | [docs/slices/SLICE_06_FOLLOWUP_SETTLEMENT.md](docs/slices/SLICE_06_FOLLOWUP_SETTLEMENT.md)     |
| 7 — Resources / fulfillment             | `IMPLEMENTED (manual paths)` | [docs/slices/SLICE_07_RESOURCES_FULFILLMENT.md](docs/slices/SLICE_07_RESOURCES_FULFILLMENT.md) |
| 8 — Notifications                       | `IMPLEMENTED`                | [docs/slices/SLICE_08_NOTIFICATIONS.md](docs/slices/SLICE_08_NOTIFICATIONS.md)                 |
| 9 — Check-In / Support Signal interface | `IMPLEMENTED`                | [docs/slices/SLICE_09_CHECKINS_SIGNALS.md](docs/slices/SLICE_09_CHECKINS_SIGNALS.md)           |
| 10 — MVP-reference UI                   | `IMPLEMENTED`                | [docs/slices/SLICE_10_MVP_UI.md](docs/slices/SLICE_10_MVP_UI.md)                               |
| 11 — Scale / resilience harness         | `IMPLEMENTED (drills only)`  | [docs/slices/SLICE_11_RESILIENCE_HARNESS.md](docs/slices/SLICE_11_RESILIENCE_HARNESS.md)       |
| 12 — D-011 scoring (`qv-001`/`sv-001`)  | `IMPLEMENTED`                | [docs/slices/SLICE_12_SIGNAL_SCORING.md](docs/slices/SLICE_12_SIGNAL_SCORING.md)               |

Slices 1–12 each record conformance and returned gaps. Slice 12 registers the
released `sv-001` engine. G-I-28 remains open. No readiness gate has advanced,
and production remains blocked until SPEC-018.

**D-011 is `DECIDED` as of v0.2.0** for questionnaire `qv-001` and rules
`sv-001`. The released engine is registered with `released: true` and the B4
golden vectors are conformance fixtures. TEST/CI stay on
`SUAS_SUPPORT_SIGNAL_MODE=fixture`. G-I-28 remains open: a settled signal does
not open or update a Support Case. D-012 (approved safety/crisis copy) is
`DECIDED` as of v0.1.5 (`SAFETY_COPY.md`); the veteran-facing crisis slot
renders the released 911/988 copy when `SUAS_SAFETY_COPY_MODE=approved` and a
labelled placeholder otherwise.

Per-capability provider disclosure is no longer globally absent. v0.1.2 closed
D-017 (Uber selected behind `TransportationPort`) and v0.1.3 closed D-018 (Amadeus
selected behind `TemporaryShelterPort`); both ship as adapter-local realizations
with released field-level disclosure projections, deterministic ranking, provider
health/fallback, and SUAS-side idempotency, and both keep their manual adapters
mandatory (`RELEASE_DECISIONS-0.1.2.md`, `RELEASE_DECISIONS-0.1.3.md`). Amadeus
reservation remains `BLOCKED_BY_PAYMENT_ARCHITECTURE`. D-019 (food) and D-020
(external peer support) stay `DECISION_PENDING`, so those capabilities remain
manual/fake only.

Manual coordination — which the release makes first-class — works end to end, and
every real-external-effect path still fails closed until SPEC-018, proven by test.
No readiness gate has advanced, and production remains blocked until SPEC-018.

## Objective

Build SUAS against the released v0.2.0 contracts and continuously prove conformance without upgrading any production-unavailable release feature by implication.

## Slice 1 — Foundation

Implement project/tooling structure, lockfiles, deterministic install/build/lint/typecheck/test commands, typed configuration validation, `.env.example`, build provenance/version surface, PostgreSQL migration/schema-version harness, test harness, synthetic-fixture boundary, CI skeleton, and durable-job abstraction seam.

Must cite: `HANDOFF.md`, `ENVIRONMENT.md`, ARCHITECTURE, DATA_MODEL, VERSIONING, RELEASE_MANIFEST.

No real external effects.

## Slice 2 — Event/idempotency kernel

Persistent command idempotency, event envelope, replay-safe publication/outbox-equivalent semantics, correlation/causation, duplicate-delivery tests.

## Slice 3 — Identity / tenancy / authorization

User, Organization, Membership, passwordless auth abstraction, shared session revocation semantics, privileged MFA boundary, tenant isolation, role + tenant + row + consent authorization. Production auth/email/SMS providers remain unavailable; use fakes/test seams.

## Slice 4 — Consent and privacy kernel

Consent Grants, use-time evaluation, revocation, minimum-necessary projection, Trusted Circle visibility, audit paths.

## Slice 5 — Coordination kernel

Support Case, CaseAssignment, Service Request, responder one-winner claim/reassignment, Contact Attempt, explicit transition commands.

## Slice 6 — Follow-Up / Settlement

Stale-job schedule identity, blocking/carry-forward, multi-cycle Settlement history, idempotent resolve, reopen behavior.

## Slice 7 — Resources / fulfillment

Resource, Referral, ServiceProvider, ProviderAdapterConfiguration, FulfillmentAttempt, ServiceFulfillment, Provider Router, Manual/Fake adapters. Real providers remain unavailable/manual-only.

## Slice 8 — Notifications

Logical-send dedupe, durable-job abstraction, consent re-check, fake email/SMS, IN_APP path.

## Slice 9 — Check-In / Support Signal interface

Questionnaire/Check-In/versioning and deterministic engine interface. Use clearly labeled unreleased fixtures only; production scoring remains unavailable.

## Slice 10 — MVP-reference UI

Veteran, responder/QRF, resource, chat, admin surfaces with truthful pending/no-availability states, WCAG target, deterministic visual fixtures.

## Slice 11 — Scale / resilience harness

Horizontal-instance, duplicate delivery, stale-work, concurrency, provider-timeout, queue-backlog, event-recovery, session-revoke, migration/restore simulation. No production numeric SLO/RTO/RPO is invented.

## Per-slice definition of done

Each slice includes:

- released spec references;
- changed files/packages;
- unit/domain/integration/E2E evidence as applicable;
- migration/data invariants;
- environment/config changes and `.env.example` updates;
- release-manifest availability-boundary verification;
- security/privacy/failure/idempotency notes where relevant;
- unresolved semantic gaps returned to `SUAS-specs`;
- no readiness claim beyond evidence.

## SPEC-017 completion

SPEC-017 completes only when the built implementation is audited against the entire released v0.2.0 cut and all material gaps are fixed or returned to specs. SPEC-018 remains required before any real pilot or production operation. No readiness gate advances with D-011.
