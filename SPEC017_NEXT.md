# SPEC017_NEXT.md — Current conformance residual

**Date:** `2026-09-17`  
**Authority:** existing SPEC-017 release authority  
**Not authorized by:** D-037  
**Pin audit:** [docs/PIN_INVENTORY.md](docs/PIN_INVENTORY.md)

Slices 1–12 are recorded `IMPLEMENTED` in [SPEC017_PLAN.md](SPEC017_PLAN.md). SPEC-017 is not complete. `UI_CONFORMANCE` stays `NOT_READY`.

## 1. Pin state

Runtime constants pin `0.6.0` / `RELEASE_MANIFEST-0.6.0.md`. Living handoff docs match.

## 2. Slice 10 residuals

| Residual | Status | Rule |
|---|---|---|
| Veteran join / browser EMAIL OTP | `IMPLEMENTED` on `/app/join`, `/app/auth/challenges`, `/app/auth/verify`, `/app/auth/logout` when `SUAS_BROWSER_AUTH_MODE=email_otp` | AUTH.md §9.1; already-enrolled only |
| Native sign-in parity | specified in `suas-specs` [D033_SIGN_IN_PARITY.md](https://github.com/scrimshawlife-ctrl/suas-specs/blob/main/D033_SIGN_IN_PARITY.md) | Bearer on `/api/v0`; no `/app` cookie; iOS and Android same meaning |
| Chat HTML | unwired | truthful unavailable state already required; do not invent a live chat backend |
| Metrics HTML | unwired | ANALYTICS.md operational metrics only; D-025 still open; no clinical claims |

The plan line “Join … stay unwired” is stale for join. Chat and metrics remain.

## 3. Out of this lane

- D-037 funding overlay, GCP evidence project, credit spend
- SPEC-018
- Moving the Worker onto Google Cloud
- Wrapping `/app/join` in a native WebView

## 4. Next product PR

Chat HTML truthful-unavailable surface, or Android `/api/v0` sign-in client matching iOS and [D033_SIGN_IN_PARITY.md](https://github.com/scrimshawlife-ctrl/suas-specs/blob/main/D033_SIGN_IN_PARITY.md). Pin stays `0.6.0`.
