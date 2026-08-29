# D-012 canonical copy review inventory

**Canonical authority:** `../SUAS-specs/SAFETY_COPY.md` v0.1.5. This inventory identifies the complete review surface without reproducing or altering authoritative wording. The canonical document remains the only source for exact text, destinations, actions, and labels.

| Review group | Canonical sections | Automated coverage reference | Human verdict |
| --- | --- | --- | --- |
| Veteran-facing crisis and triage states | §1.1–§1.14 | `tests/unit/ui-surfaces.test.ts`, `tests/integration/ui.test.ts` | BLOCKED_PENDING_NAMED_SAFETY_REVIEWER |
| Banner and persistent footer | §2.1–§2.3 | `tests/unit/ui-contract.test.ts`, `tests/integration/http-resources.test.ts` | BLOCKED_PENDING_NAMED_SAFETY_REVIEWER |
| Operator-side high-risk handling | §3 and its subsections | `tests/unit/ui-surfaces.test.ts`, `tests/unit/truthfulness.test.ts` | BLOCKED_PENDING_NAMED_SAFETY_REVIEWER |
| Notification and failure-state language | canonical notification/failure provisions | `tests/unit/email-templates.test.ts`, `tests/unit/truthfulness.test.ts` | BLOCKED_PENDING_NAMED_SAFETY_REVIEWER |
| Destination and truthfulness constraints | §0 boundaries and applicable surface sections | `tests/unit/config.test.ts`, `tests/unit/truthfulness.test.ts` | BLOCKED_PENDING_NAMED_SAFETY_REVIEWER |

## Reviewer instructions

1. Read each applicable canonical block directly from `SAFETY_COPY.md`.
2. Compare rendered implementation and route-specific fallback state to the canonical text.
3. Record each result and any exception in `human-review-worksheet.md`.
4. Sign only as the named Safety Reviewer. Automated test success is not a substitute for this decision.

No message was rewritten, released, or represented as newly approved by this campaign.
