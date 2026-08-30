# SUAS continuation plan

**Date:** 2026-08-30  
**Repository:** `scrimshawlife-ctrl/suas`  
**Baseline:** `main` at `0a65999947528ba42a63443dd604485df62d45c5` after PR #146
**Scope:** synthetic-STAGING engineering and evidence only. Pilot and production authorization remain blocked.

## Current verified state

- Browser EMAIL OTP is deployed on `suas-synthetic-staging` with Resend as the sole email provider.
- Both `https://suasqrf.com` and `https://suas-synthetic-staging.suas.workers.dev` serve the same Worker application.
- Sanitized live browser-auth evidence run [33293111386](https://github.com/scrimshawlife-ctrl/suas/actions/runs/33293111386) observed a successful Resend send event for the approved synthetic account and no message for an unknown account. The workflow did not read an OTP or message body.
- The latest deployment run [33296508053](https://github.com/scrimshawlife-ctrl/suas/actions/runs/33296508053) passed at baseline commit `0a65999947528ba42a63443dd604485df62d45c5`.
- The latest deployed Chromium acceptance run [33296533377](https://github.com/scrimshawlife-ctrl/suas/actions/runs/33296533377) passed.
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

### P1. Refresh sanitized live auth evidence after the hardening series

PRs #140, #144, #145, and #146 changed the deployed challenge boundary after the last Resend-backed evidence run.

1. Run the canonical `staging-auth-evidence` workflow from current `main`.
2. Confirm both hosts, canonical redirects, approved and unknown challenge equivalence, API bearer-only behavior, cross-origin rejection, and one non-failure Resend delivery state.
3. Confirm unknown, oversized, non-form, and rate-limited requests do not create provider sends.
4. Record only workflow IDs, deployed commit, normalized statuses, and provider delivery metadata.

**Exit condition:** one current sanitized workflow run covers the post-#146 deployed boundary without reading message bodies or OTPs.

### P2. Close the network-signal rate-limit decision before coding it

Canonical `AUTH.md` requires challenge throttling by address/account and network signal where appropriate. The runtime has shared persistent destination limits and request-address plumbing, but no released network threshold or explicit trusted-address policy.

1. Decide the synthetic/pilot network issuance threshold and window.
2. Decide which address source is authoritative at each runtime boundary, including Cloudflare `CF-Connecting-IP` and direct Node execution.
3. Specify behavior when no trustworthy address is available. Prefer fail-safe shared throttling over silently unmetered traffic.
4. Specify privacy-safe storage, retention, and audit rules for network subjects. Do not store raw address data if a keyed or normalized subject satisfies the control.
5. Only after release, implement persistent network rate limiting and acceptance tests across the Worker dispatch boundary.

**Exit condition:** a released decision supplies threshold, trust, privacy, and unavailable-address semantics, followed by implementation evidence. Until then, do not invent values.

### P3. Produce isolated backup-restore evidence

The migration harness proves clean-database migration, not backup restoration or measured RTO/RPO.

Current blocker:

```text
RECOVERY_EXERCISE=BLOCKED
reason=MISSING_AUTHENTICATED_NEON_RESTORE_CAPABILITY
```

After an authenticated recovery capability is available:

1. Restore a representative synthetic-STAGING backup into an isolated target.
2. Validate schema version, canonical tenant, browser-auth enrollment state, authoritative sessions, and durable-job behavior.
3. Record elapsed restore time, backup age, and observed data-loss boundary.
4. Keep the restored target isolated and remove it only through the approved recovery runbook.
5. Do not promote synthetic RTO/RPO measurements into production guarantees.

**Exit condition:** the recovery evidence pack distinguishes migration from restore and records schema, tenant, session, durable-job, RTO, and RPO observations.

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
| Approved challenge reaches Resend                                     | Sanitized live run 33293111386 observed `sent`                    | Refresh from post-#146 `main`.                   |
| Unknown challenge does not send                                       | Sanitized live evidence plus integration coverage                 | Refresh from post-#146 `main`.                   |
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
