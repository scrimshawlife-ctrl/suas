# Continuation execution status

**Date:** 2026-08-30  
**Baseline:** `main` at `751800c2ad7d7fa26de842a0b9e417d336725534`

## Completed

- PR #148 extended `npm run evidence:staging:browser-auth` across the post-hardening challenge boundary without reading OTPs or message bodies.
- Sanitized live run [33297787796](https://github.com/scrimshawlife-ctrl/suas/actions/runs/33297787796) passed from merged `main` at `251503c46209c1a0c2c06d61d13e59d0ed287b91`.
- Both deployed hosts returned root `302`, enrollment `200`, protected API `401`, browser-cookie API `401`, and cross-origin write `401`.
- Approved and unknown challenge responses matched. Cross-origin challenge returned `401`, oversized returned `413`, non-form returned `415`, and rate-limited returned `429` with a positive retry window.
- Resend metadata reported the approved challenge as `sent`; unknown and rejected challenge destinations produced zero provider messages.
- PR #134 added `npm run evidence:staging:browser-auth`, a metadata-only command that checks both deployed hosts, approved and unknown challenge behavior, protected API boundaries, cross-origin browser writes, and Resend delivery metadata without retrieving message bodies or OTPs.
- PR #136 added the manually dispatched `staging-auth-evidence` workflow and a protected `RESEND_AUDIT_API_KEY` boundary for sanitized live evidence. The credential that was exposed outside the secret store was revoked and replaced without printing the replacement value.
- PR #137 made the evidence command require an explicit non-failure Resend delivery state. Live run [33293111386](https://github.com/scrimshawlife-ctrl/suas/actions/runs/33293111386) passed against both deployed hosts and observed `delivery_status=sent`.
- The live evidence run confirmed both roots redirect to `/app`, both join pages return `200`, protected API access with no bearer token or a browser cookie returns `401`, cross-origin state-changing access returns `401`, approved and unknown challenges return the same normalized public response, the approved challenge creates a Resend send event, and the unknown challenge creates no message.
- Worker deployment run [33292362130](https://github.com/scrimshawlife-ctrl/suas/actions/runs/33292362130) passed using `actions/checkout@v5` and `actions/setup-node@v5` without the prior Node.js 20 action warning.
- Staging acceptance run [33292389576](https://github.com/scrimshawlife-ctrl/suas/actions/runs/33292389576) passed using the upgraded actions.
- Latest Worker deployment `448b2d91-3c9c-485b-876f-c5f7459c95b5`, version `078664b4-056f-451a-8a4b-e4e50f195730`, retains:
  - `SUAS_ENV=STAGING`
  - `SUAS_EMAIL_MODE=resend`
  - real-world effects disabled
  - D-007 deletion execution disabled
  - D-025 reporting disabled
  - pilot and production launch blocked

## Owner workflow outstanding

The deployed owner OTP sign-in still requires the owner to enter the code privately and record only the redirect, authenticated surface, cookie attributes, logout outcome, and revoked-session result. Automation did not open or read the mailbox, retrieve an OTP, or inspect a session cookie.

## Recovery execution evidence

```text
RECOVERY_EXERCISE=PARTIAL
result=ISOLATED_SNAPSHOT_RESTORE_PASSED
remaining=DURABLE_JOB_FIXTURES_AND_ISOLATED_APPLICATION_SMOKE
```

After the owner approved an immediate drill, the authenticated Neon connector created a manual snapshot of the canonical synthetic-STAGING branch and restored it into the isolated, non-default `recovery-drill-20260830` branch. The branch became ready without changing active STAGING. Aggregate-only checks observed schema migration head 14, one synthetic tenant, persisted authentication/session state, audit continuity, and an empty schema diff against active STAGING. The measured branch-ready duration was 7 seconds from snapshot creation and the observed source-to-snapshot loss boundary was 80 seconds.

The restored snapshot contained zero durable-job fixtures, and no isolated effects-disabled runtime was bound to the target. Durable-job replay/loss behavior and application smoke remain `NOT_COMPUTABLE` rather than inferred. The branch is preserved for evidence review, and no database credential or row-level identity data was exposed. Full observations are in `docs/readiness/evidence/synthetic-staging-2026-08-29/recovery/status.md`.

## Gates preserved

Production effects, D-007 destructive execution, D-025 sensitive reporting, UI/accessibility approval, and Android remain blocked pending their explicit gates. No completion claim was made for owner OTP entry, screen-reader review, durable-job recovery, isolated application smoke, or production RTO/RPO.
