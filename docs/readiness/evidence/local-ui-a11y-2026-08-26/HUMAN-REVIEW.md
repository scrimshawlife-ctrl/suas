# Human UI / a11y review notes — 2026-08-27

**Reviewer:** Daniel (eng assist)  
**Basis:** Pinned pack HTML + live STAGING Worker (`SUAS_ENV=STAGING`) with seeded bearers  
**Claim:** Partial human review for UI_CONFORMANCE evidence. **Does not flip the gate to READY.**

## Method

1. Markup `auditAccessibility` already **12/12 PASS** (machine).
2. Lighthouse a11y **100** on veteran-home + responder snapshots (machine).
3. Visual pass on pinned screenshots + live `/app` surfaces after STAGING promote.
4. Checks: landmark structure, heading hierarchy, control labels, contrast of primary text/actions, obvious focus targets, 390px vs 1280px layouts.

## Findings

| Severity | Surface | Finding | Disposition |
| --- | --- | --- | --- |
| Note | All `file://` screenshots | Captured HTML without Worker CSS may look sparse/blank vs live | Prefer live STAGING for visual sign-off; HTML still valid for markup audit |
| Note | Case page | Radio groups for channel/outcome/category use fieldsets + legends | Pass |
| Note | Preferences | Toggle buttons are labeled `Enable/Disable {CHANNEL}` | Pass |
| Open | All | Full keyboard focus-order + 320 CSS px reflow not instrumented in this pass | Remains for UI_CONFORMANCE READY |
| Open | All | Screen-reader live pass not run | Remains for READY |
| Open | Immediate resources | Still `placeholder_test_only` safety copy (D-012) | SAFETY gate, not UI alone |

## Verdict

- **Safe to treat as STAGING-class HTML evidence for soak demos.**
- **UI_CONFORMANCE stays NOT_READY** until a human completes focus-order, 320px reflow, and SR pass (and preferably re-pins screenshots from live STAGING CSS).

## Sign-off

- Eng structural review: **done** (this file).
- Owner visual/SR sign-off: **pending**.
