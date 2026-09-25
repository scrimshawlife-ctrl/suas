# SPEC-017 completion audit — released stack `0.6.0`

**Released spec stack:** `0.6.0`  
**Release manifest:** `RELEASE_MANIFEST-0.6.0.md`  
**Specs merge:** `fb27e54114c003c15f7bc74254e0c26c0da1ec0a` (`src/release/pins.ts`)  
**Decision ledgers:** `RELEASE_DECISIONS-0.6.0.md` (D-004); `RELEASE_DECISIONS-0.3.0.md` (D-033 / opens D-034); `RELEASE_DECISIONS-0.2.0.md` (D-011); `RELEASE_DECISIONS-0.1.5.md` (D-012); `RELEASE_DECISIONS-0.1.3.md` (D-018); `RELEASE_DECISIONS-0.1.2.md` (D-017); `RELEASE_DECISIONS-0.1.0.md` otherwise  
**Wave C:** owner-accepted fail-closed `ACCEPT_AS_SPECIFIED` (2026-09-25) — not a stack bump  
**Stage:** `SPEC-017` implementation conformance  
**Pilot / production readiness:** `NOT_READY` (unchanged by this audit)  

**Supersedes:** the prior completion audit filed against stack `0.2.0` in this path. Slice records that keep older stack headers remain historical; this document is the current-cut cross-check.

This document is implementation evidence, not a readiness claim. Readiness is
recorded in the specs' `STATUS.md` on accepted evidence, and SPEC-018 remains the
only path to any real pilot or production operation. No readiness gate advances
here.

## 1. Purpose and scope

`SPEC017_PLAN.md` states: "SPEC-017 completes only when the built implementation
is audited against the entire released cut and all material gaps are fixed or
returned to specs." This audit performs that cross-check against the released
`0.6.0` cut: it confirms every planned slice is implemented, cross-checks the
build's provenance and availability boundaries against the released manifests and
decision ledgers, consolidates gaps returned to specs (including Wave C
fail-closed rows), and records post-`0.2.0` contract additions that landed under
the same SPEC-017 stage (D-033 native clients, D-004 Resend / browser auth).

It audits the built implementation as it stands on the default branch. It does not
re-author every per-slice analysis, change any released product/domain rule, or
advance any gate.

## 2. Method and provenance cross-check

- Consolidated the twelve `SPEC017_PLAN.md` slice records in `docs/slices/` plus
  the D-004 Resend record `docs/slices/EMAIL_RESEND.md`.
- Cross-checked `src/release/pins.ts` against `RELEASE_MANIFEST-0.6.0.md`,
  `STATUS.md`, and the D-004 / D-033 / D-011 / D-012 / D-017 / D-018 ledgers in
  `scrimshawlife-ctrl/suas-specs` at pin commit `fb27e541…`.
- Verified provider-adapter and disclosure-projection surfaces
  (`src/fulfillment/*`, `src/privacy/projection.ts`), Resend EMAIL port
  (`src/notifications/resend-email.ts`), browser `/app` auth routes, JSON
  sign-in tenant resolve (`src/identity/signin-tenant.ts`), and Wave C honest
  unavailability on `/app/chat` and `/app/responder`.
- Sibling native clients (separate repos): Android `RootActivity` + `SupportKind`
  including `PEER_SUPPORT`; iOS `ServiceCategory` including `PEER_SUPPORT`;
  staging HTTPS; memory-only session / clear stale disk keys (D-034 open).
- Quality gate this session (2026-09-25): `npm run typecheck` pass; `npm run lint`
  pass; `npm run test:unit` — **609 tests across 45 files** pass. Full
  `npm run verify` (integration against PostgreSQL 17 + OpenAPI/staging contract)
  was not re-run in this environment; prior slice records and integration suites
  under `tests/integration/` remain the durable integration evidence.

Pin identities OBSERVED: `SPEC_VERSION = 0.6.0`,
`RELEASE_MANIFEST = RELEASE_MANIFEST-0.6.0.md`,
`SPECS_COMMIT = fb27e54114c003c15f7bc74254e0c26c0da1ec0a`,
`API_PREFIX = /api/v0`, `EVENT_SCHEMA_VERSION = 0.1.0`,
`EXPECTED_SCHEMA_VERSION = 14`, `IMPLEMENTATION_STAGE = SPEC-017`,
`PRODUCTION_READINESS = NOT_READY`, `SPEC_018_PRODUCTION_AUTHORIZED = false`.

## 3. Slice conformance status

All twelve `SPEC017_PLAN.md` slices remain `IMPLEMENTED` (Slice 11 drills-only;
Slice 7 manual paths for open D-019/D-020). Primary evidence pointers are
unchanged from the slice records.

| Slice | Status | Primary evidence |
| --- | --- | --- |
| 1 — Foundation | `IMPLEMENTED` | `docs/slices/SLICE_01_FOUNDATION.md` |
| 2 — Event / idempotency | `IMPLEMENTED` | `docs/slices/SLICE_02_EVENT_IDEMPOTENCY.md` |
| 3 — Identity / tenancy / authz | `IMPLEMENTED` | `docs/slices/SLICE_03_IDENTITY_TENANCY.md`; tenant-from-email `5d7d58b` |
| 4 — Consent / privacy | `IMPLEMENTED` | `docs/slices/SLICE_04_CONSENT_PRIVACY.md` |
| 5 — Coordination | `IMPLEMENTED` | `docs/slices/SLICE_05_COORDINATION.md` |
| 6 — Follow-Up / Settlement | `IMPLEMENTED` | `docs/slices/SLICE_06_FOLLOWUP_SETTLEMENT.md` |
| 7 — Resources / fulfillment | `IMPLEMENTED (manual paths)` | `docs/slices/SLICE_07_RESOURCES_FULFILLMENT.md` |
| 8 — Notifications | `IMPLEMENTED` | `docs/slices/SLICE_08_NOTIFICATIONS.md` |
| 9 — Check-In / Support Signal | `IMPLEMENTED` | `docs/slices/SLICE_09_CHECKINS_SIGNALS.md` |
| 10 — MVP UI + HTML commands | `IMPLEMENTED` | `SLICE_10_MVP_UI.md`, `SLICE_10_UI_COMMANDS.md` |
| 11 — Scale / resilience harness | `IMPLEMENTED (drills only)` | `docs/slices/SLICE_11_RESILIENCE_HARNESS.md` |
| 12 — D-011 scoring | `IMPLEMENTED` | `docs/slices/SLICE_12_SIGNAL_SCORING.md` |

### 3.A Post-`0.2.0` contracts under the same SPEC-017 stage

| Addition | Stack | Evidence |
| --- | --- | --- |
| D-004 Resend EMAIL + browser passwordless `/app` | `0.6.0` | `docs/slices/EMAIL_RESEND.md`; `src/notifications/resend-email.ts`; `/app/join` + challenge/verify |
| D-033 native mobile client surface | `0.3.0` | Specs `MOBILE_SURFACE.md`; sibling `suas-android` / `suas-ios` `/api/v0` MVP categories including `PEER_SUPPORT` |
| D-034 on-device retention | open | Android `SessionStore` memory-only; iOS clears stale UserDefaults keys; no claim D-034 closed |
| Wave C fail-closed (G-I rows) | not a bump | Specs `WAVE_C_CONSERVATIVE_DEFAULTS.md` owner-accepted; runtime chat/metrics/on-duty unavailable |
| Case open JSON | parity docs | `POST /api/v0/cases`; `D033_CASE_OPEN.md` |
| Android test harness honesty | living | `MainActivity` banner `TEST HARNESS ONLY` |

## 4. Cross-cutting conformance

### 4.1 Version identities and provenance

Spec stack, application version, API version (`/api/v0`), event schema (`0.1.0`),
and DB schema version (`14`) stay separate (`VERSIONING.md` §3; `pins.ts`,
`schema-version.ts`). Build provenance reports stack, manifest, specs commit,
environment class, and schema version without secret material.

### 4.2 Availability boundaries and pending decisions

Configuration may only further disable a feature; it cannot enable a surface the
manifest or ledger marks unavailable. Confirmed against released ledgers:

- **Closed:** D-004 (v0.6.0), D-033 (v0.3.0), D-011 (v0.2.0), D-012 (v0.1.5),
  D-017 (v0.1.2), D-018 (v0.1.3).
- **Open (production surface stays unavailable / manual / memory-only):** D-002,
  D-003, D-006, D-007, D-009, D-010, D-013, D-014, D-019–D-025, D-034, and
  inherited launch residuals.

Wave C fillings are fail-closed product rules, not readiness advances: on-duty,
chat, dashboard numbers, Quick Share stay unavailable / `NOT_COMPUTABLE`; no
PARTIAL command; person does not pick a tenant; auth timing seconds unpublished.

### 4.3 Provider fulfillment (D-017 / D-018)

Uber transportation and Amadeus temporary-shelter adapters remain adapter-local
behind the Provider Router with disclosure projections. Manual adapters remain
mandatory. Amadeus reservation stays `BLOCKED_BY_PAYMENT_ARCHITECTURE`. No real
credential use, booking, or veteran-data disclosure is authorized until SPEC-018.
`FOOD_SUPPORT` and external `PEER_SUPPORT` adapters stay open (D-019, D-020);
native clients may still submit MVP category requests for manual coordination.

### 4.4 Auth / tenancy (D-004 + G-I-35)

Browser `/app` passwordless EMAIL OTP uses the Resend path when
`SUAS_BROWSER_AUTH_MODE=email_otp` and environment rules allow. JSON `/api/v0`
sign-in resolves tenant from the enrolled email (`tenant_id` optional on the
wire). Clients may send a build-pinned synthetic tenant as a filter; the person
does not pick an organization.

### 4.5 Safety and privacy

D-012 approved crisis copy remains the rule under `SUAS_SAFETY_COPY_MODE=approved`.
No automated emergency dispatch, diagnosis, or suicide prediction. LOCAL/TEST/
STAGING fail closed on real external effects per `ENVIRONMENT.md`.

### 4.6 Test evidence (this session)

| Check | Result |
| --- | --- |
| `npm run typecheck` | pass |
| `npm run lint` | pass |
| `npm run test:unit` | 609 passed / 45 files |
| Full `npm run verify` (integration + OpenAPI + staging contract) | not re-run here; prior slice/integration evidence retained |

## 5. Material gap ledger (returned to specs)

### 5.A Closed since the `0.2.0` audit by a later released decision or Wave C

- **D-004** — Resend sole EMAIL provider; browser passwordless transport for
  enrolled accounts (v0.6.0).
- **D-033** — Native mobile client surface enabled for implementation, not
  production (v0.3.0).
- **Wave C C3/C4/C1/C2/C5** — Owner `ACCEPT_AS_SPECIFIED` fail-closed defaults
  for G-I-30…33, G-I-34…35, G-I-6…8, G-I-15/19/20, G-I-37…38. Runtime matches
  unavailable / not-computable behavior. See specs
  `WAVE_C_OWNER_CONFIRMATION_PACKET.md`.

### 5.B Still blocked on named unreleased decisions

Production surface stays unavailable/manual-only, so deferral remains safe.

- **D-019 / D-020** — food and external peer-support adapters.
- **D-021 / D-023 / D-024** — workload / SLO / recovery envelopes; harness
  refuses invented numeric targets.
- **D-007** — retention reaper.
- **D-009 / D-014** — coverage hours / location basis.
- **D-022** — durable production queue vendor.
- **D-001** — hosting/staging ownership for shared evidence hosts.
- **D-025** — sensitive aggregate reporting.
- **D-003 / D-006 / D-010 / D-013** — SMS, health-scope, payment, counsel review.
- **D-034** — on-device protection beyond memory-only minimum.
- Provider webhook authentication without a released webhook contract.

### 5.C Implementation-mechanism choices still awaiting later D-id / confirmation

Representative items from slice §10 lists remain mechanism choices, not invented
product: auth timing constants unpublished (aligned with Wave C G-I-34);
production-data deny-list; concurrent idempotency `409`; notification
template/dedupe vocabulary; rate-limited-to-manual routing. Wave C removed the
need to invent on-duty, chat, metrics, PARTIAL, or tenant-pick behavior.

## 6. Readiness gates

All twelve gates in the released `STATUS.md` remain `NOT_READY`: `AUTH`,
`CONSENT`, `CHECK-IN`, `COORDINATION`, `EXTERNAL_FULFILLMENT`, `UI_CONFORMANCE`,
`SAFETY`, `PRIVACY`, `SCALE`, `RESILIENCE`, `OPERATIONS`, `REPORTING`. A gate
changes only with reproducible evidence under `TESTING.md`, recorded in
`STATUS.md` — not by this audit. Truthful-unavailable pages do not advance
`UI_CONFORMANCE`.

## 7. Completion determination

Against the `0.6.0` cut:

- **Every planned slice is implemented** with conformance records (§3).
- **Post-`0.2.0` released contracts under SPEC-017 are implemented or honestly
  bounded** (§3.A, §4.3–§4.4): D-004 Resend/browser auth; D-033 native `/api/v0`
  clients with MVP categories; D-034 left open with memory-only practice.
- **Every material gap is fixed, returned to specs, or fail-closed by Wave C**
  (§5). Remaining gaps sit on named open decisions whose production surfaces stay
  unavailable.
- **No availability boundary is upgraded and no gate advances** (§4.2, §6).
- **Quality gate unit/lint/typecheck pass in this session** (§4.6).

This satisfies the `SPEC017_PLAN.md` completion criterion as implementation
evidence against pin `0.6.0`. It is **not** a readiness declaration: the owner
records SPEC-017 completion and any gate change in `STATUS.md` on accepted
evidence, and SPEC-018 remains the required go/no-go stage before any real pilot
or production operation.

### Recommended owner follow-ups (not this audit)

- Accept or reject this audit via [SPEC017_EVIDENCE_PACK.md](https://github.com/scrimshawlife-ctrl/suas-specs/blob/main/SPEC017_EVIDENCE_PACK.md).
- Prioritize open decisions that unblock real adapters or measurable gates
  (D-019/D-020, D-021/D-023/D-024, D-034) only when ready for SPEC-018 evidence.
- Do not invent chat, duty matching, dashboard formulas, or PARTIAL commands.
