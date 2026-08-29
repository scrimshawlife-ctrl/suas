# Authenticated-route evidence matrix

## Observed, non-privileged behavior

| Route class | Method | Credential condition | Expected result | Observed verdict |
| --- | --- | --- | --- | --- |
| Protected application route | GET | no credential | `401` without protected content | PASS, public E2E recorded in `../logs-sanitized/public-e2e-result.json` |
| Health endpoint | GET | no credential | status-only response | PASS, status-only observation recorded in `../preflight.md` |

## Required privileged matrix

The canonical runtime test is `tests/e2e/staging.spec.ts`. It conditionally executes the rows below only when an authorized operator supplies narrow synthetic-STAGING credentials and a positively identified deployment binding. Neither was available to this campaign. Credentials were neither requested nor read.

| Persona / check | Required proof | Verdict | Blocker |
| --- | --- | --- | --- |
| Veteran allow route | authorized synthetic Veteran credential, live deployment SHA/ID | BLOCKED | Missing credential and bound deployment identity |
| Responder allow route | authorized synthetic Responder credential, live deployment SHA/ID | BLOCKED | Missing credential and bound deployment identity |
| Admin allow route | authorized synthetic Admin credential, live deployment SHA/ID | BLOCKED | Missing credential and bound deployment identity |
| Role-deny matrix | all three credentials plus immutable tenant fixtures | BLOCKED | Missing authorized credentials and fixture provenance |
| Direct-ID / cross-tenant access | controlled fixture IDs and audit capture | BLOCKED | Missing approved synthetic dataset/map and runtime capture |
| Revocation / expired-session denial | approval, controlled account state, audit capture | BLOCKED | Missing approval and authorized controlled runtime access |

This matrix makes no claim about a deployed runtime beyond the two public, non-mutating observations. It does not authorize credential use, a pilot, production, or any real-world effect.
