# Human UI / a11y review notes — 2026-08-27

**Reviewer:** Daniel (eng assist)  
**Basis:** Pinned pack HTML + live STAGING Worker (`SUAS_ENV=STAGING`) with seeded bearers  
**Claim:** Partial human review for UI_CONFORMANCE evidence. **Does not flip the gate to READY.**

## Method

1. Markup `auditAccessibility` already **12/12 PASS** (machine).
2. Lighthouse a11y **100** on veteran-home + responder snapshots (machine).
3. Visual pass on pinned screenshots + live `/app` surfaces after STAGING promote.
4. Checks: landmark structure, heading hierarchy, control labels, contrast of primary text/actions, obvious focus targets, 390px vs 1280px layouts.
5. Deployed Chromium acceptance now checks the visible skip link and 320 CSS px
   horizontal reflow on public, veteran, responder, seeded case, and admin surfaces.

## Findings

| Severity | Surface | Finding | Disposition |
| --- | --- | --- | --- |
| Note | All `file://` screenshots | Captured HTML without Worker CSS may look sparse/blank vs live | Prefer live STAGING for visual sign-off; HTML still valid for markup audit |
| Note | Case page | Radio groups for channel/outcome/category use fieldsets + legends | Pass |
| Note | Preferences | Toggle buttons are labeled `Enable/Disable {CHANNEL}` | Pass |
| Pass | 14 deployed surfaces | 320 CSS px reflow has no document-level horizontal overflow | Playwright against formal synthetic STAGING |
| Pass | Public + veteran + responder + admin entry | First Tab reveals and focuses `Skip to main content`; Enter targets `#main` | Playwright against formal synthetic STAGING |
| Open | Interactive workflows | Full control-to-control keyboard order has not received human sign-off | Remains for UI_CONFORMANCE READY |
| Open | All | Screen-reader live pass not run | Remains for READY |
| Open | Immediate resources | Still `placeholder_test_only` safety copy (D-012) | SAFETY gate, not UI alone |

## Verdict

- **Safe to treat as STAGING-class HTML evidence for soak demos.**
- **UI_CONFORMANCE stays NOT_READY** until a human completes full workflow focus-order and
  screen-reader passes. Automated 320px reflow and keyboard-entry checks now run against live
  STAGING, but do not substitute for that sign-off.

## Sign-off

- Eng structural review: **done** (this file).
- Owner visual/SR sign-off: **pending**.
