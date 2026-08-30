# SUAS continuation plan

**Date:** 2026-08-30  
**Repository:** `scrimshawlife-ctrl/suas`  
**Baseline:** `main` at `251503c46209c1a0c2c06d61d13e59d0ed287b91` after PR #148
**Scope:** synthetic-STAGING engineering and evidence only. Pilot and production authorization remain blocked.

## Current verified state

- Browser EMAIL OTP is deployed on `suas-synthetic-staging` with Resend as the sole email provider.
- Both `https://suasqrf.com` and `https://suas-synthetic-staging.suas.workers.dev` serve the same Worker application.
- Sanitized live browser-auth evidence run [33293111386](https://github.com/scrimshawlife-ctrl/suas/actions/runs/33293111386) observed a successful Resend send event for the approved synthetic account and no message for an unknown account. The workflow did not read an OTP or message body.
- The latest deployment run [33296508053](https://github.com/scrimshawlife-ctrl/suas/actions/runs/33296508053) passed at baseline commit `0a65999947528ba42a63443dd604485df62d45c5`.
- The latest deployed Chromium acceptance run [33296533377](https://github.com/scrimshawlife-ctrl/suas/actions/runs/33296533377) passed.
- Post-hardening sanitized auth evidence run [33297787796](https://github.com/scrimshawlife-ctrl/suas/actions/runs/33297787796) passed from current `main`: both hosts passed redirect, enrollment, bearer-only, and cross-origin checks; approved and unknown public responses matched; rejected cross-origin, oversized, non-form, and rate-limited challenges returned `401`, `413`, `415`, and `429`; Resend reported `sent`; and all negative paths produced zero provider messages.
- Canonical local verification at this baseline passed 83 test files, 1,109 tests, the synthetic-STAGING contract, and the 54-route OpenAPI drift check.
- Required secret and binding boundaries remain fail-closed. Real-world effects, D-007 destructive execution, D-025 sensitive reporting, pilot launch, and production launch remain disabled.

## Browser and authentication hardening completed

The following merged changes now form the deployed browser-security baseline:

| PR                                                          | Merge commit                               | Result                                                                                                               |
| ----------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| [#139](https://github.com/scrimshawlife-ctrl/suas/pull/139) | `00350fafdd0ebb19ba62b36424765689c3e6b7cb` | Added browser response security headers and no-store policy.                                                         |
| [#140](https://github.com/scrimshawlife-ctrl/suas/pull/140) | `d1e592d5146bece4c3b86303c2d06f6e3b37025b` | Rejected cross-origin browser-auth submissions before side effects.                                                  |
| [#141](https://github.com/scrimshawlife-ctrl/suas/pull/141) | `903591eb1ba75e5522cc43d7fa63fb3ccbb2f0ab` | Replaced `unsafe-inline` with an exact stylesheet hash.                                                              |
| [#142](https://github.com/scrimshawlife-ctrl/suas/pull/142) | `26af4ac71b47d4c2d27ca7feeecaf6c030fc37a8` | Removed external font dependencies and made the web surface self-contained.                                          |
| [#143](https://github.com/scrimshawlife-ctrl/suas/pull/143) | `6e35720ee407c3bb8152c9f2d15c2365ddacd560` | Enforced strict browser isolation headers.                                                                           |
| [#144](https://github.com/scrimshawlife-ctrl/suas/pull/144) | `66ca4abb27393331cc810d61aa2bc3f3e2eb9012` | Bounded unauthenticated browser-auth request bodies to 4 KiB.                                                        |
| [#145](https://github.com/scrimshawlife-ctrl/suas/pull/145) | `e054bcffdc2a2962adbfa9f6dc8195b7e0834698` | Restricted browser-auth submissions to HTML form encoding without consuming codes or sending email on rejected JSON. |
| [#146](https://github.com/scrimshawlife-ctrl/suas/pull/146) | `0a65999947528ba42a63443dd604485df62d45c5` | Added positive `Retry-After` metadata to persistent authentication rate limits.                                      |

Deployed checks confirmed strict isolation, bounded bodies, form-only browser authentication, canonical `415 UNSUPPORTED_MEDIA_TYPE`, and `429 RATE_LIMITED` responses with positive retry windows on both public hosts.

## Guardrails

1. Work only against the independently owned synthetic-STAGING environment.
2. Never print, log, commit, or store OTPs, provider keys, session credentials, cookies, database URLs, or bearer credentials in evidence.
3. Keep Resend as the sole email provider and retain the approved sender identity.
4. Do not interpret synthetic delivery, browser acceptance, or security hardening as pilot or production authorization.
5. Do not mark UI or accessibility review complete until the owner workflow and human screen-reader review are signed off.
6. Do not implement a network/IP authentication threshold without a released threshold and trusted-client-address decision.
7. Keep Android deferred until an explicit repository decision changes that boundary.

## Ordered continuation

### P0. Complete owner-observed browser sign-in and logout

This remains the shortest acceptance gap and cannot be automated because automation must not retrieve the OTP.

1. The owner opens `https://suasqrf.com/app/join?role=veteran`.
2. The owner requests and privately enters a fresh code.
3. Record only these outcomes:
   - redirect to `/app/home`;
   - authenticated veteran surface renders;
   - the session cookie is `Secure`, `HttpOnly`, `SameSite=Strict`, and `Path=/app`;
   - logout redirects to `/app` and clears the cookie;
   - the prior session no longer authenticates.
4. Store no screenshot, trace, mailbox content, cookie value, or code.

**Exit condition:** an owner-signed worksheet records every outcome above without secret material.

### P1. Refresh sanitized live auth evidence after the hardening series — completed

PR #148 extended the canonical metadata-only command across the post-hardening challenge boundary. Run 33297787796 then passed from merged `main` without reading message bodies or OTPs.

1. Both hosts redirected roots to `/app`, rendered enrollment, and kept protected APIs bearer-only.
2. Approved and unknown challenges returned matching normalized public responses.
3. Cross-origin, oversized, non-form, and rate-limited challenge paths returned `401`, `413`, `415`, and `429`; the rate limit advertised a positive retry window.
4. Resend reported the approved challenge as `sent` and reported zero messages for every unknown or rejected destination.
5. Evidence contained workflow IDs, normalized statuses, and provider metadata only.

**Exit condition:** met by run 33297787796. Re-run after future release-affecting authentication changes.

### P2. Close the network-signal rate-limit decision before coding it

Canonical `AUTH.md` requires challenge throttling by address/account and network signal where appropriate. The runtime has shared persistent destination limits and request-address plumbing, but no released network threshold or explicit trusted-address policy.

1. Decide the synthetic/pilot network issuance threshold and window.
2. Decide which address source is authoritative at each runtime boundary, including Cloudflare `CF-Connecting-IP` and direct Node execution.
3. Specify behavior when no trustworthy address is available. Prefer fail-safe shared throttling over silently unmetered traffic.
4. Specify privacy-safe storage, retention, and audit rules for network subjects. Do not store raw address data if a keyed or normalized subject satisfies the control.
5. Only after release, implement persistent network rate limiting and acceptance tests across the Worker dispatch boundary.

**Exit condition:** a released decision supplies threshold, trust, privacy, and unavailable-address semantics, followed by implementation evidence. Until then, do not invent values.

### P3. Complete isolated backup-restore evidence

An owner-approved immediate Neon snapshot drill restored the canonical synthetic-STAGING source into the isolated, non-default `recovery-drill-20260830` branch. The target reached `ready`, schema comparison against active STAGING returned no diff, and aggregate-only checks observed migration head 14, one synthetic tenant, persisted authentication/session state, audit continuity, a 7-second branch-ready restore observation, and an 80-second source-to-snapshot loss boundary.

Current partial result:

```text
RECOVERY_EXERCISE=PARTIAL
passed=ISOLATED_RESTORE_SCHEMA_TENANT_SESSION_AUDIT
remaining=DURABLE_JOB_FIXTURES_AND_ISOLATED_APPLICATION_SMOKE
```

The source snapshot contained zero durable-job fixtures, and no effects-disabled isolated runtime was bound to the target. The current evidence must not be represented as durable-job recovery, end-user application recovery, or a production RTO/RPO guarantee.

Next closure:

1. Preserve `recovery-drill-20260830` until evidence review or explicit teardown approval.
2. Prepare a later synthetic snapshot with approved queued, leased, completed, retrying, and dead-letter job fixtures.
3. Restore that snapshot into a separately named isolated target.
4. Bind an effects-disabled isolated runtime without production, provider, notification, or real-data connectivity.
5. Verify zero acknowledged-job loss, no completed-job replay, safe lease recovery/retry behavior, and application smoke through public interfaces.
6. Record the second drill's RTO, RPO, backup age, and loss boundary without promoting synthetic measurements into production guarantees.

**Exit condition:** the recovery evidence pack records passing schema, tenant, session, durable-job, and application-smoke observations plus sanitized RTO/RPO measurements.

### P4. Run human web-surface and accessibility review

Automated Chromium coverage is necessary but does not close human usability or accessibility approval.

1. Exercise public, veteran, responder, seeded responder, admin, food-resource, and immediate-resource surfaces at 320 px and representative desktop widths.
2. Complete keyboard-only, focus-order, visible-focus, zoom/reflow, contrast, and reduced-motion checks.
3. Complete screen-reader review with a human reviewer.
4. Review safety copy and crisis-resource presentation without inventing local resources or operational claims.
5. File concrete defects and keep approval open until fixes are re-observed.

**Exit condition:** owner or specialist sign-off records the tested workflows and unresolved defects without claiming broader compliance.

### P5. Continue only behind released product gates

- D-007 production deletion and retention execution remains blocked on explicit authorization.
- D-025 sensitive aggregate reporting remains disabled pending privacy, safety, access-control, and rendered-report review.
- Real fulfillment effects remain unavailable until provider and production decisions are released.
- iOS may continue against `/api/v0` only within the released contract.
- Android remains explicitly deferred.
- Pilot and production launch remain blocked.

## Verification matrix

| Requirement                                                           | Current evidence                                                  | Remaining closure                                |
| --------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------ |
| Both public hosts serve the same application                          | Canonical deployments, Chromium acceptance, direct HTTPS checks   | Recheck after every deployment-affecting change. |
| Approved challenge reaches Resend                                     | Post-hardening run 33297787796 observed `sent`                    | Re-run after release-affecting auth changes.     |
| Unknown and rejected challenges do not send                           | Run 33297787796 observed zero negative-path provider messages     | Re-run after release-affecting auth changes.     |
| Cross-origin, oversized, and non-form writes fail before side effects | Integration tests and deployed Chromium acceptance                | Preserve in every release-affecting auth change. |
| Authentication rate limits are persistent and actionable              | Database-backed integration plus deployed `429` and `Retry-After` | Network-signal threshold remains decision-gated. |
| Cookie hardening and logout revocation                                | Integration suite                                                 | Owner-observed deployed sign-in and logout.      |
| API remains bearer-only                                               | Integration and sanitized deployed evidence                       | Preserve after auth changes.                     |
| Database remains synthetic and canonical                              | Hyperdrive inspection, migration workflow, staging provisioning   | Isolated backup restore remains blocked.         |
| UI and accessibility are acceptable                                   | Automated rendering and reflow coverage                           | Human workflow and screen-reader sign-off.       |
| No production authorization is implied                                | Fail-closed variables, docs, and workflows                        | Preserve all gates.                              |

## Stop conditions

Stop and report rather than improvising if any of these occur:

- Resend delivery is not accepted, sent, or delivered during the approved evidence workflow.
- Either public host stops serving the same Worker application.
- Hyperdrive no longer targets the authorized synthetic database.
- A required credential or authenticated integration is absent and cannot be reused safely.
- A step would expose an OTP, provider key, session secret, cookie, full database URL, or bearer credential.
- Network/IP throttling would require inventing an unreleased threshold, trust policy, or retention rule.
- Recovery work would require an unapproved database target or production data.
- Work requires production effects, destructive D-007 execution, D-025 reporting, Android implementation, or another unreleased owner decision.
