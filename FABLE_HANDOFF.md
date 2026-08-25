# FABLE_HANDOFF.md — SUAS implementation handoff

## Canonical release

Build against `scrimshawlife-ctrl/SUAS-specs` release **v0.2.0**.

- Specs merge: `4a722e69ad8f7ff45a9581ca3bdd022bdf524f8f`
- Manifest: `RELEASE_MANIFEST-0.2.0.md`
- Decision ledger: `RELEASE_DECISIONS-0.2.0.md` (D-011); inherited `RELEASE_DECISIONS-0.1.5.md` (D-012); `RELEASE_DECISIONS-0.1.3.md` (D-018); `RELEASE_DECISIONS-0.1.2.md` (D-017); `RELEASE_DECISIONS-0.1.0.md` otherwise.
- Current stage: SPEC-017 implementation conformance
- Production/pilot readiness: `NOT_READY`

## Read order

1. This file.
2. `CONTEXT.md` in this repo.
3. `AGENTS.md`.
4. `SPEC017_PLAN.md`.
5. In `SUAS-specs`: `HANDOFF.md`.
6. `ENVIRONMENT.md`.
7. `RELEASE_MANIFEST-0.2.0.md`.
8. `STATUS.md`, `PRODUCT.md`, `GLOSSARY.md`.
9. `ARCHITECTURE.md`, `DOMAIN_MODEL.md`, `DATA_MODEL.md`, `API.md`, `APIS.md`, `TESTING.md`.
10. Domain files for the slice you are implementing.

## First task

Start with **SPEC-017 Slice 1 — Foundation**. Do not jump to UI/provider work first.

Slice 1 should establish:

- chosen project/toolchain structure and lockfiles;
- deterministic install/build/lint/typecheck/test commands;
- typed configuration schema implementing `ENVIRONMENT.md`;
- `.env.example` mapping;
- build/version provenance surface;
- PostgreSQL migration/schema-version harness;
- test harness and synthetic fixture boundary;
- repository quality checks/CI skeleton;
- durable-job abstraction seam without choosing an unreleased production queue vendor;
- no real external effects.

## Hard constraints

- `SUAS-specs` is canonical; code does not redefine it.
- If a product/domain rule is missing, return it to specs instead of guessing.
- LOCAL/TEST/STAGING cannot use production data or real support effects.
- Production operation is blocked until SPEC-018.
- Real email/SMS/auth/service-provider vendors are not authorized by the current release; use disabled/fake/sink/manual seams.
- D-011 released `qv-001` + `sv-001` as implementation-authoritative scoring. TEST/CI stay on `SUAS_SUPPORT_SIGNAL_MODE=fixture`. That mode is never production authority. APPLY_EFFECTIVE_SIGNAL transcribes SAFETY.md §3.2 (RED opens/updates a case; non-RED is a no-op; CLOSED is not REOPEN). Real provider adapters stay out of this packet. D-012 approved safety copy is gated by `SUAS_SAFETY_COPY_MODE` (`approved` renders it; TEST/CI stay on `placeholder_test_only`).
- No automated emergency dispatch, diagnosis, suicide prediction, or safety-critical generative AI.
- No provider SDK types/statuses in domain modules.
- Preserve MVP visual/interaction identity when the UI slice begins.

## Every PR must include

- released spec citations;
- changed-file → spec-section mapping;
- tests/evidence for affected invariants;
- env/config changes and `.env.example` updates;
- migration notes for schema changes;
- idempotency/failure behavior where relevant;
- security/privacy impact;
- explicit unavailable-feature boundaries;
- unresolved semantic gaps returned to specs.

## Version identities

Keep these separate:

- spec stack: `0.2.0`;
- application version: implementation-owned;
- API version: `/api/v0`;
- event schema: `0.1.0` until revised;
- DB migration/schema version: explicit implementation mechanism;
- runtime content versions: questionnaire/signal/templates/etc.

A build should expose app version/commit, spec version, release manifest, environment class, and schema/migration version.

## Definition of successful handoff

You should be able to begin Slice 1 without asking what is canonical, what can contact real systems, which environment classes exist, how versions are identified, or which production surfaces are still disabled.
