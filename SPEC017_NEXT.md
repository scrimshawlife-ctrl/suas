# SPEC017_NEXT.md — Current conformance residual

**Date:** `2026-09-17`  
**Authority:** existing SPEC-017 release authority  
**Not authorized by:** D-037  
**Pin audit:** [docs/PIN_INVENTORY.md](docs/PIN_INVENTORY.md)

Slices 1–12 are recorded `IMPLEMENTED` in [SPEC017_PLAN.md](SPEC017_PLAN.md). SPEC-017 is not complete. `UI_CONFORMANCE` stays `NOT_READY`.

## 1. Pin state

Runtime constants already pin `0.6.0` / `RELEASE_MANIFEST-0.6.0.md` (`src/release/pins.ts`, `.env.example`, CI). Living handoff docs were still advertising `0.2.0`. That is documentation drift, not an open pin choice.

`suas-specs` STATUS "Next stage" text named `0.4.0` while the stack header is `0.6.0`. That is specs editorial drift. It does not authorize a second pin.

## 2. Product residuals named by Slice 10

| Residual | Status | Rule |
|---|---|---|
| Veteran join HTML | unwired | released MVP_REFERENCE / AUTH only; no new journey |
| Chat HTML | unwired | truthful unavailable state already required; do not invent a live chat backend |
| Metrics HTML | unwired | ANALYTICS.md operational metrics only; D-025 still open; no clinical claims |

## 3. Out of this lane

- D-037 funding overlay, GCP evidence project, credit spend
- SPEC-018
- Moving the Worker onto Google Cloud
- Inventing Run 001 JSON

## 4. Next product PR after this inventory

Join / chat / metrics HTML against released contracts, one residual at a time. Pin constants stay `0.6.0` unless a later release manifest supersedes them.
