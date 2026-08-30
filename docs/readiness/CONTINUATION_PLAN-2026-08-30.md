# SUAS continuation plan

**Date:** 2026-08-30  
**Repository:** `scrimshawlife-ctrl/suas`  
**Baseline:** `main` after PRs [#131](https://github.com/scrimshawlife-ctrl/suas/pull/131) and [#132](https://github.com/scrimshawlife-ctrl/suas/pull/132)  
**Scope:** synthetic-STAGING engineering and evidence only. Pilot and production authorization remain blocked.

## Verified baseline

- Browser EMAIL OTP is deployed on `suas-synthetic-staging` with Resend as the sole provider.
- Worker deployment run [33291476297](https://github.com/scrimshawlife-ctrl/suas/actions/runs/33291476297) passed at commit `43c7f80af549c2f68e304a39745e2681e552a12e`.
- Worker version `bd6244de-0138-4146-a425-98a9c916931f` serves both `https://suas-synthetic-staging.suas.workers.dev` and `https://suasqrf.com`.
- A deployed challenge for the approved synthetic account produced one successful Resend API request and a delivered message. Unknown accounts received the same public response and produced no message.
- Canonical deployed Chromium acceptance run [33291719345](https://github.com/scrimshawlife-ctrl/suas/actions/runs/33291719345) passed after PR #132 removed an ambiguous locator.
- Migration run [33291188181](https://github.com/scrimshawlife-ctrl/suas/actions/runs/33291188181) passed against the authorized synthetic-STAGING database.
- Required secrets are present by name, Hyperdrive targets the authorized synthetic database, and real-world effects, pilot launch, and production launch remain disabled.
- No Postmark references remain in canonical source outside immutable dependency material.

## Guardrails

1. Work only against the independently owned synthetic-STAGING environment.
2. Never expose OTPs, provider keys, session credentials, database URLs, or bearer credentials in logs or evidence.
3. Keep Resend as the sole email provider and retain the approved sender identity.
4. Do not interpret successful synthetic delivery as pilot or production authorization.
5. Do not mark UI or accessibility review complete until owner workflow and screen-reader review are signed off.
6. Keep Android deferred until an explicit repository decision changes that boundary.

## Ordered continuation

### P0. Complete owner-observed browser sign-in evidence

This is the shortest remaining acceptance gap, but it requires a human because automation must not retrieve the OTP.

1. The owner requests a fresh code from `https://suasqrf.com/app/join?role=veteran`.
2. The owner enters the received code without sharing it with automation.
3. Record only outcome metadata:
   - redirect to `/app/home`
   - authenticated veteran surface renders
   - session cookie attributes are visible as `Secure`, `HttpOnly`, `SameSite=Strict`, and `Path=/app`
   - logout redirects to `/app`, clears the cookie, and the previous session no longer authenticates
4. Store no screenshot or trace that exposes the code, cookie, mailbox content, or bearer material.

**Exit condition:** an owner-signed worksheet records the complete deployed sign-in and logout outcome without secret material.

### P1. Make deployed browser-auth evidence repeatable

Engineering should add a metadata-only acceptance path that can prove the integration without reading message content.

1. Extend the staging runbook with the exact Cloudflare and Resend metadata queries used for delivery evidence.
2. Add an acceptance script that:
   - verifies both deployed hosts and canonical redirects
   - submits approved and unknown challenges
   - compares normalized public responses
   - asserts exactly one provider send event for the approved account
   - never requests email bodies or OTP values
3. Preserve the existing integration tests for cookie hardening, authoritative logout revocation, same-origin browser writes, and API bearer-only behavior.
4. Add a sanitized evidence summary under `docs/readiness/evidence/` after each release-affecting auth change.

**Exit condition:** one documented command produces a sanitized pass/fail report across the Worker, custom domain, database boundary, and Resend delivery boundary.

### P2. Remove workflow maintenance warnings

The successful deployment and acceptance runs still warn that `actions/checkout@v4`, `actions/setup-node@v4`, and `actions/upload-artifact@v4` target deprecated Node.js 20.

1. Upgrade the deployment and staging-acceptance workflows to supported action majors already proven by the repository's `verify` workflow.
2. Run `npm run verify` and both manually dispatched staging workflows.
3. Confirm no behavior, secret scope, environment, or deployment provenance changed.

**Exit condition:** canonical deployment and acceptance runs pass without Node.js 20 action warnings.

### P3. Produce backup-restore evidence

The migration harness proves clean-database migration, not backup restoration or measured RTO/RPO.

1. Use the authorized synthetic database and approved recovery setup only.
2. Restore from a representative backup into an isolated target.
3. Validate schema version, canonical tenant, browser-auth enrollment state, authoritative sessions, and durable-job behavior.
4. Record elapsed restore time and the observed data-loss boundary without promoting synthetic measurements to production guarantees.

**Exit condition:** the recovery evidence pack distinguishes migration success from backup-restore success and records the measured synthetic boundaries.

### P4. Continue readiness engineering only behind released decisions

- D-007 production deletion and retention execution remains blocked on explicit authorization. Keep destructive paths disabled.
- D-025 sensitive aggregate reporting remains disabled pending privacy, safety, access-control, and rendered-report review.
- Real fulfillment effects remain unavailable until provider and production decisions are released.
- Human accessibility, safety-copy, contrast, focus, and screen-reader review remain owner or specialist gates.
- iOS may continue against `/api/v0` only within the released contract. Android remains explicitly deferred.

## Verification matrix

| Requirement                                    | Evidence path                                                                 |
| ---------------------------------------------- | ----------------------------------------------------------------------------- |
| Public app and enrollment on both hosts        | Deployed Chromium acceptance and direct HTTPS checks                          |
| Approved challenge reaches Resend              | Resend API log plus delivered-message metadata                                |
| Unknown account does not send                  | Normalized public response comparison plus absence of a second provider send  |
| Browser cookie hardening and logout revocation | Integration suite, followed by owner-observed deployed sign-in                |
| API remains bearer-only                        | Deployed authenticated acceptance plus negative cookie checks                 |
| Database remains synthetic and canonical       | Hyperdrive inspection, migration validation, and staging provisioning command |
| No production authorization implied            | Worker variables and readiness documents retain fail-closed launch flags      |

## Stop conditions

Stop and report rather than improvising if any of these occur:

- Resend delivery is not accepted or delivered.
- Either public host stops serving the same Worker application.
- Hyperdrive no longer targets the authorized synthetic database.
- A required credential is absent and cannot be reused safely.
- A requested step would expose an OTP, secret, full database URL, session cookie, or bearer credential.
- Work requires production data, production effects, or an unreleased owner decision.
