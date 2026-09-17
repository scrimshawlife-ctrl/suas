# SPEC017_NEXT.md — Current conformance residual

**Date:** `2026-09-17`  
**Authority:** existing SPEC-017 release authority  
**Not authorized by:** D-037  
**Does not advance:** any TESTING.md readiness gate  
**Does not authorize:** production, real veteran data, real external effects, GCP spend

Slices 1–12 are recorded `IMPLEMENTED` in [SPEC017_PLAN.md](SPEC017_PLAN.md). SPEC-017 is not complete. `UI_CONFORMANCE` stays `NOT_READY`.

## 1. Pin drift

This repository still pins specs `0.2.0` ([FABLE_HANDOFF.md](FABLE_HANDOFF.md), [README.md](README.md), `src/release/pins.ts`).

`suas-specs` current released stack is `0.6.0` ([STATUS.md](https://github.com/scrimshawlife-ctrl/suas-specs/blob/main/STATUS.md)). STATUS next-stage text still names `0.4.0` as the pin target. That is specs-side wording drift. Code must not guess which of `0.4.0` / `0.6.0` is the fail-closed pin.

**Next implementation PR:** inventory `SUAS_SPEC_VERSION` / `SUAS_RELEASE_MANIFEST` against the live `suas-specs` release manifest. Return the pin choice to specs if the STATUS sentence and the stack header disagree. Do not silently retarget to `0.6.0`.

## 2. Product residuals named by Slice 10

From [SPEC017_PLAN.md](SPEC017_PLAN.md):

| Residual | Status | Rule |
|---|---|---|
| Veteran join HTML | unwired | released MVP_REFERENCE / AUTH only; no new journey |
| Chat HTML | unwired | truthful unavailable state already required; do not invent a live chat backend |
| Metrics HTML | unwired | ANALYTICS.md operational metrics only; D-025 still open; no clinical claims |

Do not start these until the pin inventory lands. They are UI wiring against released contracts, not new product.

## 3. Out of this lane

- D-037 funding overlay, GCP evidence project, credit spend
- Option 2 limited-implementation authority for funding tasks
- SPEC-018
- Moving the Worker onto Google Cloud
- Inventing Run 001 JSON

If a TEST fixture loop later exists for product reasons, a sealed packet may be copied into `suas-specs` `evidence/runs/SUAS-EVIDENCE-RUN-001/`. That copy is optional and is not a gate for these residuals.

## 4. Definition of the next successful PR

A pin-inventory PR that:

- cites `RELEASE_MANIFEST` files actually on `suas-specs` main
- lists every runtime file that embeds `0.2.0`
- either proposes a pin target that matches a single released manifest, or opens a specs issue for the `0.4.0` vs `0.6.0` STATUS mismatch
- changes no Veteran journey and spends no credits
