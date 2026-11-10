# IMPLEMENTATION_BOOTSTRAP.md — Released v0.9.0 handoff

**Status:** `ACTIVE`  
**Released specification:** `0.9.0`  
**Implementation authority:** `RELEASED_FOR_IMPLEMENTATION`  
**Current stage:** `SPEC-018` (blocked). SPEC-017 evidence recorded against pin `0.6.0`.

## Canonical source

- Specs release merge pin: `208705cfd2b6aa1ce913ac9e70a2d42a1c9487ad` (`src/release/pins.ts`)
- Release manifest: `RELEASE_MANIFEST-0.9.0.md`
- Release decision ledger: `RELEASE_DECISIONS-0.9.0.md` (D-055 to D-063); inherited `RELEASE_DECISIONS-0.8.0.md` (D-050 to D-054); `RELEASE_DECISIONS-0.7.0.md` (D-038, with the D-037 record); `RELEASE_DECISIONS-0.6.0.md` (D-004); `RELEASE_DECISIONS-0.5.0.md` / `0.4.0.md` (D-035); `RELEASE_DECISIONS-0.3.0.md` (D-033); `RELEASE_DECISIONS-0.2.0.md` (D-011); `RELEASE_DECISIONS-0.1.5.md` (D-012); `RELEASE_DECISIONS-0.1.3.md` (D-018); `RELEASE_DECISIONS-0.1.2.md` (D-017); `RELEASE_DECISIONS-0.1.0.md` otherwise
- Handoff: `HANDOFF.md` in `SUAS-specs`; current residual: `SPEC017_NEXT.md`
- Environment contract: `ENVIRONMENT.md`
- Pin audit: [docs/PIN_INVENTORY.md](docs/PIN_INVENTORY.md)

## Implementation sequence

1. Read `FABLE_HANDOFF.md`, `CONTEXT.md`, AGENTS, `SPEC017_PLAN.md`, and `SPEC017_NEXT.md` here.
2. Read the released `0.9.0` manifest, HANDOFF, ENVIRONMENT, STATUS, PRODUCT, GLOSSARY in specs.
3. Create a change map from every implementation package/file to released spec sections.
4. Read `SPEC017_NEXT.md` and specs `REMAINING.md`. SPEC-017 evidence is recorded; do not restart at Foundation. Do not invent SPEC-018 product.
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

Implementation stays on the pinned `0.9.0` stack. SPEC-017 evidence is recorded and does not authorize production; SPEC-018 remains the blocked go/no-go stage.
