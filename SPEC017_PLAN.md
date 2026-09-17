# SPEC017_PLAN.md — Implementation conformance plan

**Released spec (current pin):** `0.6.0` (`src/release/pins.ts`, `RELEASE_MANIFEST-0.6.0.md`)  
**Plan opened against:** `0.1.1`; slices 1–12 were recorded while the stack moved `0.1.1` → `0.6.0`  
**Status:** `IN_PROGRESS`  
**Implementation repository:** `scrimshawlife-ctrl/SUAS`  
**Canonical specs:** `scrimshawlife-ctrl/SUAS-specs`  
**What to build next:** [SPEC017_NEXT.md](SPEC017_NEXT.md)

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
| 10 follow-on — HTML command wiring      | `IMPLEMENTED`                | [docs/slices/SLICE_10_UI_COMMANDS.md](docs/slices/SLICE_10_UI_COMMANDS.md)                     |
| 11 — Scale / resilience harness         | `IMPLEMENTED (drills only)`  | [docs/slices/SLICE_11_RESILIENCE_HARNESS.md](docs/slices/SLICE_11_RESILIENCE_HARNESS.md)       |
| 12 — D-011 scoring (`qv-001`/`sv-001`)  | `IMPLEMENTED`                | [docs/slices/SLICE_12_SIGNAL_SCORING.md](docs/slices/SLICE_12_SIGNAL_SCORING.md)               |

The Slice 10 follow-on wires deploy / cancel / claim HTML POSTs. On-duty HTML states unavailability instead of posting a dead form. A signed-in veteran can finish `qv-001` on `/app/check-ins`.

Web sign-in, the Chat tab, and responder summary tiles exist. Sign-in sends an email code when that mode is on. Chat says unavailable. Summary tiles say the numbers have no definition. `POST /api/v0/cases` opens or returns the Veteran’s one non-closed Case.

SPEC-017 and `UI_CONFORMANCE` do **not** advance because those pages exist.

See [SPEC017_NEXT.md](SPEC017_NEXT.md). D-037 does not add slices here. Slice records that landed under `0.2.0` keep that header.

**D-011 is `DECIDED` as of v0.2.0** for `qv-001` and `sv-001`. TEST/CI stay on `SUAS_SUPPORT_SIGNAL_MODE=fixture`. APPLY_EFFECTIVE_SIGNAL opens or updates a Support Case from a settled effective `RED` only. D-012 is `DECIDED` as of v0.1.5; the crisis slot renders 911/988 copy when `SUAS_SAFETY_COPY_MODE=approved`.

D-017 (Uber) and D-018 (Amadeus) stay adapter-local. Amadeus reservation stays blocked on payment architecture. D-019 and D-020 stay open, so food and external peer support stay manual/fake. Real external effects fail closed until SPEC-018.

## Objective

Build against the current `0.6.0` contracts. Prove conformance. Do not turn on a production-blocked feature because code exists.

## Slice 1 — Foundation

Project structure, lockfiles, install/build/lint/typecheck/test, typed config, `.env.example`, build provenance, PostgreSQL migrations, test harness, synthetic fixtures, CI, durable-job seam.

Must cite: `HANDOFF.md`, `ENVIRONMENT.md`, ARCHITECTURE, DATA_MODEL, VERSIONING, RELEASE_MANIFEST.

No real external effects.

## Slice 2 — Event/idempotency kernel

Persistent command idempotency, event envelope, replay-safe publication, correlation/causation, duplicate-delivery tests.

## Slice 3 — Identity / tenancy / authorization

User, Organization, Membership, passwordless auth, shared session revocation, privileged MFA boundary, tenant isolation. Production auth/email/SMS providers stay unavailable except D-004 Resend as the EMAIL adapter; LOCAL/TEST stay sink/fake.

## Slice 4 — Consent and privacy kernel

Consent Grants, use-time evaluation, revocation, minimum-necessary projection, Trusted Circle visibility, audit paths.

## Slice 5 — Coordination kernel

Support Case, CaseAssignment, Service Request, one-winner claim, Contact Attempt, explicit transition commands.

## Slice 6 — Follow-Up / Settlement

Stale-job schedule identity, blocking/carry-forward, multi-cycle Settlement, idempotent resolve, reopen.

## Slice 7 — Resources / fulfillment

Resource, Referral, ServiceProvider, adapter configuration, FulfillmentAttempt, ServiceFulfillment, router, Manual/Fake adapters.

## Slice 8 — Notifications

Logical-send dedupe, durable jobs, consent re-check, fake email/SMS, IN_APP path.

## Slice 9 — Check-In / Support Signal interface

Questionnaire/Check-In/versioning and the released `sv-001` engine. TEST/CI stay on fixture mode.

## Slice 10 — MVP-reference UI

Veteran, responder, resource, chat, admin surfaces with truthful unavailable or not-computable states.

## Slice 11 — Scale / resilience harness

Instance rotation, duplicate delivery, stale work, concurrency, provider timeout, queue backlog, event recovery, session revoke, migration/restore simulation. No invented production SLO numbers.

## Per-slice definition of done

Each slice includes released spec citations, changed files, tests, migration notes, env/config, availability-boundary checks, security/privacy/failure notes, gaps returned to specs, and no readiness claim beyond evidence.

## SPEC-017 completion

SPEC-017 completes only when the build is audited against the current released cut and material gaps are fixed or returned to specs. SPEC-018 remains required before any real pilot or production operation.
