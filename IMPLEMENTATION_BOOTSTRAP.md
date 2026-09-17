# IMPLEMENTATION_BOOTSTRAP.md — Released v0.6.0 handoff

**Status:** `ACTIVE`  
**Released specification:** `0.6.0`  
**Implementation authority:** `RELEASED_FOR_IMPLEMENTATION`  
**Current stage:** `SPEC-017`

## Canonical source

- Specs release merge pin: `fb27e54114c003c15f7bc74254e0c26c0da1ec0a` (`src/release/pins.ts`)
- Release manifest: `RELEASE_MANIFEST-0.6.0.md`
- Release decision ledger: `RELEASE_DECISIONS-0.6.0.md` (D-004); inherited `RELEASE_DECISIONS-0.5.0.md` / `0.4.0.md` (D-035); `RELEASE_DECISIONS-0.3.0.md` (D-033); `RELEASE_DECISIONS-0.2.0.md` (D-011); `RELEASE_DECISIONS-0.1.5.md` (D-012); `RELEASE_DECISIONS-0.1.3.md` (D-018); `RELEASE_DECISIONS-0.1.2.md` (D-017); `RELEASE_DECISIONS-0.1.0.md` otherwise
- Handoff: `HANDOFF.md` in `SUAS-specs`; current residual: `SPEC017_NEXT.md`
- Environment contract: `ENVIRONMENT.md`
- Pin audit: [docs/PIN_INVENTORY.md](docs/PIN_INVENTORY.md)

## Implementation sequence

1. Read `FABLE_HANDOFF.md`, `CONTEXT.md`, AGENTS, `SPEC017_PLAN.md`, and `SPEC017_NEXT.md` here.
2. Read the released `0.6.0` manifest, HANDOFF, ENVIRONMENT, STATUS, PRODUCT, GLOSSARY in specs.
3. Create a change map from every implementation package/file to released spec sections.
4. Execute the current SPEC-017 residual in `SPEC017_NEXT.md`. Slices 1–12 are already recorded; do not restart at Foundation.
5. Keep typed configuration/startup validation, build provenance, and schema/migration/test harness intact.
6. Keep persistent idempotency/replay-safe events intact before externally consequential flows.
7. Implement Manual/Fake provider and notification seams before any newly authorized real provider integration.
8. Continuously run conformance tests and return semantic gaps to `SUAS-specs`.

## Hard boundaries

Do not make operational through code/config defaults:

- production infrastructure or real external effects;
- real veteran data/live pilot;
- production Support Signal compute (`sv-001` is implementation-authoritative; env stays `disabled|fixture`);
- official safety/crisis copy as the TEST/CI default;
- real external transportation/shelter/food/peer providers beyond adapter-local D-017/D-018 paths that still fail closed until SPEC-018;
- production workload/SLO/RTO/RPO values;
- legal/compliance claims;
- sensitive aggregate reporting.

LOCAL/TEST/STAGING are synthetic-only and real-external-effect forbidden under `ENVIRONMENT.md`.

## Definition of SPEC-017 start

Implementation continues against the pinned `0.6.0` stack and records conformance evidence per residual. SPEC-017 completion still does not authorize production; SPEC-018 remains the go/no-go stage.
