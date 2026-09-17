# What to build next

**Date:** `2026-09-17`  
**Pin:** `0.6.0` / `RELEASE_MANIFEST-0.6.0.md`  
**Still not ready:** production, pilot, `UI_CONFORMANCE`

Slices 1–12 are recorded in [SPEC017_PLAN.md](SPEC017_PLAN.md). That does not mean the product is finished.

## Already in this repo

| Surface | What it does |
|---|---|
| Web sign-in | `/app/join` plus email code when `SUAS_BROWSER_AUTH_MODE=email_otp` |
| Chat tab | `/app/chat` says chat is unavailable |
| Responder summary tiles | `/app/responder` says the numbers have no definition |
| Open a Case from JSON | `POST /api/v0/cases` — one non-closed Case per Veteran |

Phone rules for those surfaces: [D033_SIGN_IN_PARITY.md](https://github.com/scrimshawlife-ctrl/suas-specs/blob/main/D033_SIGN_IN_PARITY.md), [D033_CHAT_PARITY.md](https://github.com/scrimshawlife-ctrl/suas-specs/blob/main/D033_CHAT_PARITY.md), [D033_METRICS_PARITY.md](https://github.com/scrimshawlife-ctrl/suas-specs/blob/main/D033_METRICS_PARITY.md), [D033_CASE_OPEN.md](https://github.com/scrimshawlife-ctrl/suas-specs/blob/main/D033_CASE_OPEN.md).

Do not wrap the web pages in a WebView and call that iOS or Android.

## Not this work

Funding overlay, Google Cloud evidence project, credit spend, production launch, invented chat, invented dashboard formulas.

## Next code

Android app: JSON sign-in and `POST /api/v0/cases`, same as iOS. Then drop any `/app/qrf/deploy` and `/dev/…` calls from the iOS staging build.
