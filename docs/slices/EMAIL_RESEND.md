# Email vendor — Resend EmailPort: conformance record

**Released spec stack:** `0.6.0`
**Release manifest:** `RELEASE_MANIFEST-0.6.0.md`
**Specs merge:** `fb27e54114c003c15f7bc74254e0c26c0da1ec0a`
**Stage:** `SPEC-017`
**Production/pilot readiness:** `NOT_READY` (unchanged)

This record implements the Resend EMAIL capability port selected by D-004.
It does not close D-002, D-006, or SPEC-018. It does not set
`SUAS_ALLOW_REAL_EXTERNAL_EFFECTS=true`.

## 1. Released spec citations

| Spec                        | Sections relied on                                                                                         |
| --------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `ENVIRONMENT.md`            | §3 notifications (`disabled\|fake\|sink\|resend`), §3 rules 3–4, §5 required secrets, §6–§7 secret classes |
| `NOTIFICATIONS.md`          | §2 do not fake delivery, §6 accepted ≠ delivered, §10 no bodies/credentials in logs, §11 no vendor leak    |
| `AUTH.md`                   | §2 passwordless where email is configured, §9 provider-neutral delivery; do not fake success               |
| `ARCHITECTURE.md`           | §11 `EmailPort`, §13 finite timeouts                                                                       |
| `RELEASE_MANIFEST-0.6.0.md` | D-004 and browser-auth boundary; SPEC-017 stays not ready                                                  |

## 2. Change map — file to spec section

| Path                                  | Implements                                                          |
| ------------------------------------- | ------------------------------------------------------------------- |
| `src/notifications/resend-email.ts`   | ARCHITECTURE.md §11 EmailPort; NOTIFICATIONS.md §2, §6, §10–§11     |
| `src/notifications/channels.ts`       | ENVIRONMENT.md §3 — Resend selected only in `resend` mode           |
| `src/auth/delivery.ts`                | AUTH.md §9 — same EMAIL port; no second Resend client               |
| `src/config/schema.ts`                | ENVIRONMENT.md §3, §5 — released mode and required slots            |
| `src/worker/env.ts`                   | Optional bindings; secrets never in `vars`                          |
| `docs/runbooks/cloudflare-workers.md` | Operator configuration for Resend and browser auth                  |
| `src/notifications/templates.ts`      | NOTIFICATIONS.md §7–§8, §10; AUTH.md §2–§3; SAFETY_COPY.md §2.3, §4 |

## 3. Vendor pick and lock

The connected Resend account already has a verified sending domain
`zer0state.com` (id `27bf3d91-8e1e-46a5-a923-7ef534d16ad9`, region
`us-east-1`). That is observed domain verification. It is not a chosen
from-line. This record does not invent a mailbox.

The 0.6.0 pin adds `resend` to `SUAS_EMAIL_MODE` and closes D-004. The
registry selects the adapter only for that mode. D-006 and production
readiness stay pending.

## 4. Evidence

| Invariant                                                                  | Evidence                                  |
| -------------------------------------------------------------------------- | ----------------------------------------- |
| HTTP success maps to `accepted` plus an opaque Resend id                   | `tests/unit/resend-email.test.ts`         |
| Provider `{ error }` or non-OK HTTP maps to `accepted: false`              | same file                                 |
| Timeout or abort maps to `accepted: false` with `timeout`                  | same file                                 |
| Structured logs omit Authorization, API keys, and message bodies           | same file                                 |
| Missing key or from address fails closed at adapter construction           | same file                                 |
| Challenge EMAIL uses the same `ResendEmailChannel.send` path               | same file                                 |
| `createChannelRegistry` selects Resend only in `resend` mode               | same file                                 |
| TEST rejects `resend`; configured STAGING accepts it                       | `tests/unit/config.test.ts`               |
| Real-effects flag stays rejected                                           | same file                                 |
| No API key or from-address mailbox in `wrangler.jsonc`                     | `tests/unit/repository-hygiene.test.ts`   |
| Every shipped EMAIL template renders subject + text + html                 | `tests/unit/email-templates.test.ts`      |
| Unknown reason or version fails closed                                     | same file                                 |
| HTML escapes interpolated context                                          | same file                                 |
| Crisis-adjacent templates use only 911/988 and omit forbidden phrases      | same file                                 |
| Resend POST body uses rendered subject/text/html                           | `tests/unit/resend-email.test.ts`         |
| `attemptSend` uses EMAIL catalog only for EMAIL; SMS/IN_APP keep text path | `tests/integration/notifications.test.ts` |
| Empty/whitespace API key or from-address fails closed at construction      | `tests/unit/resend-email.test.ts`         |

## 5. Environment and configuration changes

`RESEND_API_KEY` and `SUAS_EMAIL_FROM` are required when Resend is selected.
`wrangler.jsonc` selects `SUAS_EMAIL_MODE=resend` and keeps
`SUAS_ALLOW_REAL_EXTERNAL_EFFECTS=false`. The API key remains a platform
secret. The Worker isolate still rejects `apply` migrations and support effects.

## 6. Migration notes

No schema change. Expected version remains `11`.

## 7. Idempotency and failure behavior

- `Idempotency-Key` is `OutboundMessage.idempotencyKey` (max 256 characters).
- The same key is reused on retry of the same logical send.
- Outbound `fetch` uses the existing 10s timeout helper.
- A provider error or timeout returns `accepted: false` with a product-safe
  `failureReason`. Provider status strings do not enter product contracts.

## 8. Security and privacy impact

- The API key is a platform secret. It is never a wrangler `var`.
- Structured adapter logs record implementation, channel, accepted, and
  outcome. They do not record Authorization, keys, destinations, or bodies.
- `describeConfig` reports only whether the key and from-address slots are
  set.

## 9. Availability boundaries preserved

Only the released authentication EMAIL path becomes operational in STAGING.
SMS stays sink. Real support effects stay false. `SUAS_ENV=PRODUCTION` stays
rejected. SPEC-018 is not authorized.

## 10. Semantic gaps returned to `SUAS-specs`

1. **D-006 remains pending.** This record does not classify legal status.
2. **Sender identity remains deployment-owned.** Operators set
   `SUAS_EMAIL_FROM` in the protected environment configuration.

## 11. EMAIL templates (`email-templates/v1`)

The catalog renders `{ subject, text, html }` from OBSERVED `reason` +
`templateVersion` keys. `templateVersion` stays the version key. It is not
the human subject. Unknown keys fail closed.

| reason                   | templateVersion   | Audience        | Notes                                              |
| ------------------------ | ----------------- | --------------- | -------------------------------------------------- |
| `auth.magic_link`        | `auth.magic_link` | Veteran sign-in | AUTH.md §2 MAGIC_LINK. No crisis footer.           |
| `auth.email_otp`         | `auth.email_otp`  | Veteran sign-in | AUTH.md §2 EMAIL_OTP. No crisis footer.            |
| `trusted_contact_alert`  | `alert@1`         | Trusted contact | Observed EMAIL enqueue. SAFETY_COPY.md §2.3 footer |
| `followup_due`           | `followup@1`      | Veteran         | Observed EMAIL enqueue. SAFETY_COPY.md §2.3 footer |
| `qrf.responder_notified` | `test@1`          | Responder       | Observed enqueue (IN_APP in tests). No later state |
| `service_request_update` | `update@1`        | Veteran         | Observed enqueue. SAFETY_COPY.md §2.3 footer       |

Omitted NOTIFICATIONS.md §8 facts — no product send path and no notification
reason key in `src/`:

| §8 fact                    | Evidence                                                                          |
| -------------------------- | --------------------------------------------------------------------------------- |
| `CHECKIN_COMPLETED`        | `src/signals/check-ins.ts` emits the Domain Event only                            |
| `SUPPORT_SIGNAL_CHANGED`   | `src/signals/settlement.ts` emits the Domain Event only                           |
| `CASE_ASSIGNED`            | `src/coordination/cases.ts` emits the Domain Event only                           |
| `SERVICE_REQUEST_ASSIGNED` | `src/coordination/requests.ts` emits the Domain Event only                        |
| `SERVICE_ACCEPTED`         | Named in `src/events/envelope.ts` only                                            |
| `SERVICE_FULFILLED`        | Named in `src/events/envelope.ts` only                                            |
| `TRUSTED_CONTACT_INVITED`  | `src/consent/trusted-circle.ts` emits the Domain Event; no notification reason    |
| Consent-receipt send       | Consent templates live in `consent_template_versions`; no notification reason key |
| `PHONE_OTP`                | AUTH.md §2 SMS channel; not an EMAIL template                                     |

Test-only enqueue keys `drill_provider_outage` / `drill_duplicate_webhook` /
`drill@1` were not shipped. Those drills now use `followup_due` / `followup@1`.

`attemptSend` and challenge EMAIL go through `renderEmailTemplate`.
`createChannelRegistry` selects `ResendEmailChannel` only in `resend` mode.

## 12. Readiness statement

SPEC-017 stays `NOT READY`. SPEC-018 is not authorized. This record does
not claim live email, a Worker deploy, or production operation.
