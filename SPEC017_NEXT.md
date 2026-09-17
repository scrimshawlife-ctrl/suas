# SPEC017_NEXT.md — Current conformance residual

**Date:** `2026-09-17`  
**Authority:** existing SPEC-017 release authority  
**Not authorized by:** D-037  
**Pin audit:** [docs/PIN_INVENTORY.md](docs/PIN_INVENTORY.md)

Slices 1–12 are recorded `IMPLEMENTED` in [SPEC017_PLAN.md](SPEC017_PLAN.md). SPEC-017 is not complete. `UI_CONFORMANCE` stays `NOT_READY`.

## 1. Pin state

Runtime constants pin `0.6.0` / `RELEASE_MANIFEST-0.6.0.md`.

## 2. Slice 10 residuals

| Residual | Status | Rule |
|---|---|---|
| Veteran join / browser EMAIL OTP | `IMPLEMENTED` | AUTH.md §9.1 |
| Native sign-in parity | specified | [D033_SIGN_IN_PARITY.md](https://github.com/scrimshawlife-ctrl/suas-specs/blob/main/D033_SIGN_IN_PARITY.md) |
| Chat HTML | `IMPLEMENTED` as truthful `UNAVAILABLE` | G-I-31; [D033_CHAT_PARITY.md](https://github.com/scrimshawlife-ctrl/suas-specs/blob/main/D033_CHAT_PARITY.md) |
| Metrics HTML | `IMPLEMENTED` as `NOT_COMPUTABLE` | Live `/app/responder` Summary tiles (`Responses`, `Avg Response`) carry state `NOT_COMPUTABLE` / `No released definition`. G-I-32. D-025 still open. |
| Native metrics parity | specified | [D033_METRICS_PARITY.md](https://github.com/scrimshawlife-ctrl/suas-specs/blob/main/D033_METRICS_PARITY.md) |

Join, chat, and metrics were listed as “unwired” meaning “no invented product.” The landmarks exist and stay honest.

## 3. Out of this lane

- Inventing metric formulas, zeros-as-values, or reporting privacy thresholds
- D-037 / GCP / credit spend
- SPEC-018
- `REPORTING=READY`

## 4. Next product PR

Android `/api/v0` sign-in client matching iOS and [D033_SIGN_IN_PARITY.md](https://github.com/scrimshawlife-ctrl/suas-specs/blob/main/D033_SIGN_IN_PARITY.md), or register Veteran-reachable `POST /cases` on `/api/v0` per [D033_NATIVE_CLIENT_PLAN.md](https://github.com/scrimshawlife-ctrl/suas-specs/blob/main/D033_NATIVE_CLIENT_PLAN.md) §9. Pin stays `0.6.0`.
