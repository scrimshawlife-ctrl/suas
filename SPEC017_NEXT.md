# What to build next

**Date:** `2026-09-25`  
**Pin:** `0.6.0` / `RELEASE_MANIFEST-0.6.0.md`  
**Still not ready:** production, pilot, `UI_CONFORMANCE`  
**SPEC-017 STATUS claim:** `NO` — see specs [SPEC017_EVIDENCE_PACK.md](https://github.com/scrimshawlife-ctrl/suas-specs/blob/main/SPEC017_EVIDENCE_PACK.md)

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
| Android `/api/v0` | Sign-in, `POST /cases`, ride / food / shelter / peer-support submit (see sibling `suas-android`) |
| iOS `/api/v0` | Staging HTTPS (`suasqrf.com`), typed email code, `POST /cases`, ride / food / shelter / peer-support; `/dev/*` refused off localhost |

Phone rules for those surfaces: [D033_SIGN_IN_PARITY.md](https://github.com/scrimshawlife-ctrl/suas-specs/blob/main/D033_SIGN_IN_PARITY.md), [D033_CHAT_PARITY.md](https://github.com/scrimshawlife-ctrl/suas-specs/blob/main/D033_CHAT_PARITY.md), [D033_METRICS_PARITY.md](https://github.com/scrimshawlife-ctrl/suas-specs/blob/main/D033_METRICS_PARITY.md), [D033_CASE_OPEN.md](https://github.com/scrimshawlife-ctrl/suas-specs/blob/main/D033_CASE_OPEN.md).

Do not wrap the web pages in a WebView and call that iOS or Android.

## Not this work

Funding overlay, Google Cloud evidence project, credit spend, production launch, invented chat, invented dashboard formulas.

## Next

1. Keep phones and web on `/api/v0` only. Do not re-implement Android/iOS sign-in / case-open / MVP categories; that work is already on sibling mains.
2. Android leftover from specs `GAP_ANALYSIS.md`: dummy `MainActivity` stays for tests and must not imply live fulfillment (now labeled test harness).
3. **Refresh [docs/SPEC017_COMPLETION_AUDIT.md](docs/SPEC017_COMPLETION_AUDIT.md) against pin `0.6.0`** (header is still `0.2.0`). Wave C is already `ACCEPT_AS_SPECIFIED`; evidence STATUS claim is `NO` until that audit lands and is re-marked.
4. SPEC-018 / production / store distribution stay blocked.
