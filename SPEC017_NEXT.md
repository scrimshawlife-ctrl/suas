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
| Chat HTML | `IMPLEMENTED` as truthful `UNAVAILABLE` | `GET /app/chat` authenticates and states unavailability (G-I-31). No message store. No `/app/chat/:id` product route. |
| Native chat parity | specified | [D033_CHAT_PARITY.md](https://github.com/scrimshawlife-ctrl/suas-specs/blob/main/D033_CHAT_PARITY.md) |
| Metrics HTML | unwired / `NOT_COMPUTABLE` | ANALYTICS.md; D-025 open; no clinical claims |

The plan line that listed chat as “unwired” meant “no messaging product.” The landmark is already required and already honest on `/app/chat`.

The renderer still has an `AVAILABLE` fixture branch that can emit `Open conversation` links. That branch is not the live route. Do not promote it.

## 3. Out of this lane

- Inventing threads, compose, or a chat SDK
- D-037 / GCP / credit spend
- SPEC-018

## 4. Next product PR

Metrics HTML as `NOT_COMPUTABLE` (same honesty pattern as chat), or the Android `/api/v0` sign-in client matching iOS. Pin stays `0.6.0`.
