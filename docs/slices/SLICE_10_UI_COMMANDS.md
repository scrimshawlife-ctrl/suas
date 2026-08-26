# Slice 10 follow-on — HTML command wiring: conformance record

**Released spec stack:** `0.2.0`
**Release manifest:** `RELEASE_MANIFEST-0.2.0.md`
**Stage:** `SPEC-017`
**Production/pilot readiness:** `NOT_READY` (unchanged)
**`UI_CONFORMANCE`:** `NOT READY` (unchanged)

After Pages restyle PR #82 (`cf79b713`), the restyled Slice 10 HTML still posted
Deploy, Cancel, and (on enrollment) role navigation into routes that 404'd.
Plane A JSON already shipped the underlying commands. This cut wires only those
released facts into `/app` POST handlers. It does not invent join, on-duty,
chat, metrics, or Check-In domain.

## 1. Released spec citations

| Spec                                 | Sections used                                                                                                                                                     |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MVP_REFERENCE.md`                   | §3 / §5 required actions; §7.2 QRF deploy / cancel / contact truthfulness; §8 resource actions only with a recorded scheme; §9 on-duty and metrics stay non-facts |
| `CASES.md`                           | §3 / §3.1 one active Case; §5 claim                                                                                                                               |
| `DISPATCH.md`                        | §4 Service Request create and the explicit `CANCEL` set (reason required); §7 `PEER_SUPPORT`                                                                      |
| `RESPONDER_WORKFLOWS.md`             | §2 `CLAIM_CASE`                                                                                                                                                   |
| `API.md`                             | §4 session required; tenant and actor are server-derived                                                                                                          |
| `AUTH.md`                            | §2 / §5 challenge path and per-request session evaluation                                                                                                         |
| `RESOURCES.md`                       | §6 `contact_method` / `contact_method_kind` (P-13)                                                                                                                |
| `NOTIFICATIONS.md` / `DATA_MODEL.md` | P-12 `subject_type` / `subject_id`                                                                                                                                |

## 2. Change map — file to spec section

| Path                                    | Implements                                                                                                                  |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `src/ui/commands.ts`                    | `CASES.md` §3.1 + `DISPATCH.md` §4 / §7 composed as HTML deploy / cancel                                                    |
| `src/http/routes/ui.ts`                 | `MVP_REFERENCE.md` §7.2; `API.md` §4; `AUTH.md` §5 — POST `/app/qrf/deploy`, `/app/qrf/cancel`; same-responder claim replay |
| `src/ui/surfaces.ts`                    | Enrollment role links stay on `GET /app/join` (display-only)                                                                |
| `tests/integration/ui-commands.test.ts` | Deploy / cancel / claim success, idempotency, authz; `RESPONDER_NOTIFIED` only with a subject-linked delivery               |
| `tests/unit/ui-surfaces.test.ts`        | Form actions and enrollment hrefs                                                                                           |

## 3. What is wired

- **Deploy QRF** (`POST /app/qrf/deploy`): authenticate, `openCase` (idempotent), then create a `PEER_SUPPORT` Service Request if none is in flight. Concurrent deploys lock the Case row. 303 to `/app/home`.
- **Cancel request** (`POST /app/qrf/cancel`): authenticate, look up the veteran's in-flight request (server-derived; no client id), `CANCEL` with a recorded reason. Replay after cancel is a no-op. 303 to `/app/home`.
- **Claim** (already registered): same-responder replay now 303s instead of 409. A different responder still conflicts.
- **Resource Call / Email / Web:** already rendered from P-13 `contactMethodKind`. Untyped / `FREEFORM` still offer no guessed scheme.
- **`RESPONDER_NOTIFIED`:** already readable via P-12 subject join. An assignment alone stays off that label.

## 4. Residuals — not wired, returned to specs

1. **`/app/join` stays display-only.** `issueChallenge` / `verifyChallenge` exist, but (a) tenant resolution at sign-in is an open Slice 3 gap, (b) a challenge does not create a User, (c) LOCAL/TEST never expose the OTP over HTTP, and (d) there is no cookie UI session — HTML cannot persist a Bearer credential after verify. Inventing any of those would be new domain. Role links now stay on `GET /app/join?role=…` so they no longer 404.
2. **On-duty / availability (G-I-30).** The control still posts to `/app/responder/availability`, which has no handler. A successful POST that changed nothing would be a lie.
3. **Chat / threads (G-I-31).** Surface stays truthful `UNAVAILABLE`.
4. **Dashboard metrics (G-I-32).** Stay `NOT_COMPUTABLE`.
5. **QRF Call / Message.** Still hidden unless an authorized path exists. No counterpart consent evaluation is asserted on the live home.
6. **Check-In / Support Signal HTML.** Not added. Not in the canonical loop display.

## 5. Environment, migrations, readiness

None. `EXPECTED_SCHEMA_VERSION` is unchanged. No `.env` keys. No provider adapters.

`SPEC-017` stays **NOT READY**. `UI_CONFORMANCE` stays **NOT READY**. This PR does not claim SPEC-018, HIPAA, CCPA, TCPA, 911 dispatch, or production operation.

## 6. Security and privacy

- HTML POSTs use the same `authenticate()` gate as the GET surfaces. No weaker UI session.
- Tenant and actor are server-derived. Cancel does not trust a client-supplied request id.
- Cancel reason is server-recorded (`Cancelled by veteran from the QRF request surface.`) so the DISPATCH.md §4 reason requirement is met without a new veteran-facing field.
- No secrets in logs. No real contact-channel delivery on the HTML join surface.

## 7. Idempotency and failure

- Deploy: at most one in-flight `PEER_SUPPORT` request per veteran. A second POST writes nothing.
- Cancel: a missing or already-cancelled request 303s home.
- Claim: same responder replay 303s; another responder still receives `ALREADY_CLAIMED`.
- HTML forms do not send `Idempotency-Key`. Product-level idempotency is the Case row lock and the in-flight read, not a new kernel key that would block a legitimate deploy after cancel.
