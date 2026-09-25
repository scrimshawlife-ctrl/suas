# What to build next

**Date:** `2026-09-25`  
**Pin:** `0.6.0` / `RELEASE_MANIFEST-0.6.0.md`  
**Still not ready:** production, pilot, `UI_CONFORMANCE`

Slices 1–12 are recorded in [SPEC017_PLAN.md](SPEC017_PLAN.md). That does not mean the product is finished.

Prefer [SUAS-specs `REMAINING.md`](https://github.com/scrimshawlife-ctrl/suas-specs/blob/main/REMAINING.md) and [`GAP_ANALYSIS.md`](https://github.com/scrimshawlife-ctrl/suas-specs/blob/main/GAP_ANALYSIS.md) when this file and those disagree.

## Already shipped (OBSERVED)

| Surface | What it does |
|---|---|
| Web sign-in | `/app/join` plus email code when `SUAS_BROWSER_AUTH_MODE=email_otp` |
| JSON sign-in tenant | Worker resolves enrolled email → tenant; `tenant_id` on the wire is optional |
| Chat tab | `/app/chat` says chat is unavailable |
| Responder summary tiles | `/app/responder` says the numbers have no definition |
| Open a Case from JSON | `POST /api/v0/cases` — one non-closed Case per Veteran |
| Android `/api/v0` | Sign-in, `POST /cases`, ride / food / shelter submit (see sibling `suas-android`) |
| iOS `/api/v0` | Staging HTTPS (`suasqrf.com`), typed email code, `POST /cases`; `/dev/*` refused off localhost |

Phone rules for those surfaces: [D033_SIGN_IN_PARITY.md](https://github.com/scrimshawlife-ctrl/suas-specs/blob/main/D033_SIGN_IN_PARITY.md), [D033_CHAT_PARITY.md](https://github.com/scrimshawlife-ctrl/suas-specs/blob/main/D033_CHAT_PARITY.md), [D033_METRICS_PARITY.md](https://github.com/scrimshawlife-ctrl/suas-specs/blob/main/D033_METRICS_PARITY.md), [D033_CASE_OPEN.md](https://github.com/scrimshawlife-ctrl/suas-specs/blob/main/D033_CASE_OPEN.md).

Do not wrap the web pages in a WebView and call that iOS or Android.

## Not this work

Funding overlay, Google Cloud evidence project, credit spend, production launch, invented chat, invented dashboard formulas.

## Next

1. Keep phones and web on `/api/v0` only. Do not re-implement Android sign-in / case-open; that work is already on `suas-android` main.
2. Android leftovers from specs `GAP_ANALYSIS.md`: peer-support home card still missing; dummy `MainActivity` stays for tests and must not imply live fulfillment.
3. Owner confirm Wave C fail-closed defaults, then SPEC-017 evidence acceptance before any `STATUS.md` completion claim.
4. SPEC-018 / production / store distribution stay blocked.
