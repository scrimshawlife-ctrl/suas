# What to build next

**Date:** `2026-11-12`  
**Pin:** `0.9.0` / `RELEASE_MANIFEST-0.9.0.md` (tag `v0.9.0`)  
**Still not ready:** production, pilot, `UI_CONFORMANCE`  
**SPEC-017 status:** recorded against `0.6.0`; evidence YES on specs ([SPEC017_EVIDENCE_PACK.md](https://github.com/scrimshawlife-ctrl/suas-specs/blob/main/SPEC017_EVIDENCE_PACK.md)). SPEC-018 stays blocked; do not start it by inventing product.

Slices 1–12 are recorded in [SPEC017_PLAN.md](SPEC017_PLAN.md). That does not mean the product is finished or ready for veterans.

The list of open work lives in SUAS-specs, not here: [`REMAINING.md`](https://github.com/scrimshawlife-ctrl/suas-specs/blob/main/REMAINING.md), [`GAP_ANALYSIS.md`](https://github.com/scrimshawlife-ctrl/suas-specs/blob/main/GAP_ANALYSIS.md) and `V1_PROJECT_PLAN.md` (a proposal, not a released spec). Work is tracked on the [SUAS Product Board](https://github.com/users/scrimshawlife-ctrl/projects/6).

## Surfaces in this repository

| Surface              | Where                                                                                                     |
| -------------------- | --------------------------------------------------------------------------------------------------------- |
| JSON API `/api/v0`   | `src/http/routes/`; contract in `docs/openapi/v0.json`                                                    |
| v1 web app           | `web/` (React), on `/api/v0` only                                                                         |
| Legacy browser pages | HTML `/app/*` (`src/http/routes/ui.ts`); `/app/chat` still shows its unavailable state                    |
| AWS infrastructure   | `infra/` (CDK), synthesized and tested offline; nothing deployed                                          |
| Legacy STAGING host  | Cloudflare Worker (`src/worker*`, `wrangler.jsonc`), kept until the AWS cutover                           |
| LOCAL demo           | `npm run dev:demo`: LOCAL Worker, synthetic seed, `demo@example.invalid` / `123456` ([README](README.md)) |

Native clients live in [`suas-ios`](https://github.com/scrimshawlife-ctrl/suas-ios) and [`suas-android`](https://github.com/scrimshawlife-ctrl/suas-android); their phone rules are the D-033 parity files in SUAS-specs. Do not wrap the web pages in a WebView and call that iOS or Android.

## Not this work

Funding overlay, Google Cloud evidence project, credit spend, production launch, invented chat, invented dashboard formulas.

## Rules for the next work

1. Keep phones and web on `/api/v0` only.
2. Do not flip readiness gates. SPEC-017 evidence is YES on specs for the `0.6.0` audit.
3. Follow specs [OPERATOR_CALLS_2026-09-25.md](https://github.com/scrimshawlife-ctrl/suas-specs/blob/main/OPERATOR_CALLS_2026-09-25.md) for the open operator calls.
4. SPEC-018, production and store distribution stay blocked (owner `KEEP_BLOCKED`, specs [SPEC018_OWNER_LAUNCH_PACKET.md](https://github.com/scrimshawlife-ctrl/suas-specs/blob/main/SPEC018_OWNER_LAUNCH_PACKET.md)). Do not invent product for `KEEP_PENDING` D-ids. Do not claim HIPAA compliance.
