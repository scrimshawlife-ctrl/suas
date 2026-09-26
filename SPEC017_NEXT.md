# What to build next

**Date:** `2026-09-25`  
**Pin:** `0.6.0` / `RELEASE_MANIFEST-0.6.0.md`  
**Still not ready:** production, pilot, `UI_CONFORMANCE`  
**SPEC-017 status:** recorded against `0.6.0`; evidence YES on specs ([SPEC017_EVIDENCE_PACK.md](https://github.com/scrimshawlife-ctrl/suas-specs/blob/main/SPEC017_EVIDENCE_PACK.md)). Next is SPEC-018 prep only when owner opens launch decisions — do not start SPEC-018 work inventing product.

Slices 1–12 are recorded in [SPEC017_PLAN.md](SPEC017_PLAN.md). That does not mean the product is finished or ready for veterans.

Prefer [SUAS-specs `REMAINING.md`](https://github.com/scrimshawlife-ctrl/suas-specs/blob/main/REMAINING.md) and [`GAP_ANALYSIS.md`](https://github.com/scrimshawlife-ctrl/suas-specs/blob/main/GAP_ANALYSIS.md) when this file and those disagree.

## Already shipped (OBSERVED)

| Surface                 | What it does                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Web sign-in             | `/app/join` plus email code when `SUAS_BROWSER_AUTH_MODE=email_otp`                                                                  |
| JSON sign-in tenant     | Worker resolves enrolled email → tenant; `tenant_id` on the wire is optional                                                         |
| Chat tab                | `/app/chat` says chat is unavailable                                                                                                 |
| Responder summary tiles | `/app/responder` says the numbers have no definition                                                                                 |
| Open a Case from JSON   | `POST /api/v0/cases` — one non-closed Case per Veteran                                                                               |
| Android `/api/v0`       | Sign-in, `POST /cases`, ride / food / shelter / peer-support submit (see sibling `suas-android`)                                     |
| iOS `/api/v0`           | Staging HTTPS (`suasqrf.com`), typed email code, `POST /cases`, ride / food / shelter / peer-support; `/dev/*` refused off localhost |

Phone rules for those surfaces: [D033_SIGN_IN_PARITY.md](https://github.com/scrimshawlife-ctrl/suas-specs/blob/main/D033_SIGN_IN_PARITY.md), [D033_CHAT_PARITY.md](https://github.com/scrimshawlife-ctrl/suas-specs/blob/main/D033_CHAT_PARITY.md), [D033_METRICS_PARITY.md](https://github.com/scrimshawlife-ctrl/suas-specs/blob/main/D033_METRICS_PARITY.md), [D033_CASE_OPEN.md](https://github.com/scrimshawlife-ctrl/suas-specs/blob/main/D033_CASE_OPEN.md).

Do not wrap the web pages in a WebView and call that iOS or Android.

## Not this work

Funding overlay, Google Cloud evidence project, credit spend, production launch, invented chat, invented dashboard formulas.

## Next

1. Keep phones and web on `/api/v0` only. Do not re-implement Android/iOS sign-in / case-open / MVP categories; that work is already on sibling mains.
2. Android leftover: dummy `MainActivity` stays for tests and must not imply live fulfillment (labeled test harness).
3. SPEC-017 evidence is YES on specs for the `0.6.0` audit. Do not flip readiness gates.
4. Follow specs [OPERATOR_CALLS_2026-09-25.md](https://github.com/scrimshawlife-ctrl/suas-specs/blob/main/OPERATOR_CALLS_2026-09-25.md) (Neon preferred for D-005; D-006 still counsel; D-036 Option C; Lyft deferred).
5. SPEC-018 / production / store distribution stay blocked. Owner settled `KEEP_BLOCKED` on specs [SPEC018_OWNER_LAUNCH_PACKET.md](https://github.com/scrimshawlife-ctrl/suas-specs/blob/main/SPEC018_OWNER_LAUNCH_PACKET.md). Do not invent product for `KEEP_PENDING` D-ids. Do not claim HIPAA compliant.
