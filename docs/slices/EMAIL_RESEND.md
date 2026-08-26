# Email vendor — Resend EmailPort: conformance record

**Released spec stack:** `0.2.0`
**Release manifest:** `RELEASE_MANIFEST-0.2.0.md`
**Specs merge:** `4a722e69ad8f7ff45a9581ca3bdd022bdf524f8f`
**Stage:** `SPEC-017`
**Production/pilot readiness:** `NOT_READY` (unchanged)

This record implements the Resend EMAIL capability port. It does not send
mail. It does not deploy a Worker. It does not close D-001–D-005, D-004,
D-006, or SPEC-018. It does not set `SUAS_ALLOW_REAL_EXTERNAL_EFFECTS=true`.

## 1. Released spec citations

| Spec                        | Sections relied on                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------- |
| `ENVIRONMENT.md`            | §3 notifications (`disabled\|fake\|sink` only), §3 rules 3–4, §5 required secrets, §6–§7 secret classes |
| `NOTIFICATIONS.md`          | §2 do not fake delivery, §6 accepted ≠ delivered, §10 no bodies/credentials in logs, §11 no vendor leak |
| `AUTH.md`                   | §2 passwordless where email is configured, §9 provider-neutral delivery; do not fake success            |
| `ARCHITECTURE.md`           | §11 `EmailPort`, §13 finite timeouts                                                                    |
| `RELEASE_MANIFEST-0.2.0.md` | Readiness boundary; SPEC-017 stays not ready                                                            |

## 2. Change map — file to spec section

| Path                                  | Implements                                                         |
| ------------------------------------- | ------------------------------------------------------------------ |
| `src/notifications/resend-email.ts`   | ARCHITECTURE.md §11 EmailPort; NOTIFICATIONS.md §2, §6, §10–§11    |
| `src/notifications/channels.ts`       | ENVIRONMENT.md §3 — registry stays on `RecordingChannel`           |
| `src/auth/delivery.ts`                | AUTH.md §9 — same EMAIL port; no second Resend client              |
| `src/config/schema.ts`                | ENVIRONMENT.md §3, §5 — optional slots; `resend` mode still closed |
| `src/worker/env.ts`                   | Optional bindings; secrets never in `vars`                         |
| `docs/runbooks/cloudflare-workers.md` | Operator note: email stays sink; Resend secret is later            |

## 3. Vendor pick and lock

The connected Resend account already has a verified sending domain
`zer0state.com` (id `27bf3d91-8e1e-46a5-a923-7ef534d16ad9`, region
`us-east-1`). That is observed domain verification. It is not a chosen
from-line. This record does not invent a mailbox.

The 0.2.0 pin still lists `SUAS_EMAIL_MODE` as `disabled|fake|sink` and
says production external email is not valid. Adding `resend` to
`COMMUNICATION_MODES` would fail spec-alignment. The adapter is real
code. The registry and default committed config stay on `sink`.

D-004 (email provider) is not filed. D-006 stays pending. This record
does not claim those decisions closed.

## 4. Evidence

| Invariant                                                                  | Evidence                                |
| -------------------------------------------------------------------------- | --------------------------------------- |
| HTTP success maps to `accepted` plus an opaque Resend id                   | `tests/unit/resend-email.test.ts`       |
| Provider `{ error }` or non-OK HTTP maps to `accepted: false`              | same file                               |
| Timeout or abort maps to `accepted: false` with `timeout`                  | same file                               |
| Structured logs omit Authorization, API keys, and message bodies           | same file                               |
| Missing key or from address fails closed at adapter construction           | same file                               |
| Challenge EMAIL uses the same `ResendEmailChannel.send` path               | same file                               |
| `createChannelRegistry` stays on `RecordingChannel` when credentials exist | same file                               |
| Default `sink` still starts; `resend` mode is rejected                     | `tests/unit/config.test.ts`             |
| Real-effects flag stays rejected                                           | same file                               |
| No API key or from-address mailbox in `wrangler.jsonc`                     | `tests/unit/repository-hygiene.test.ts` |

## 5. Environment and configuration changes

Optional `RESEND_API_KEY` and `SUAS_EMAIL_FROM` appear in the typed schema
and `.env.example` as empty slots. They are not required at startup.
`wrangler.jsonc` `vars` stay `SUAS_EMAIL_MODE=sink` and
`SUAS_ALLOW_REAL_EXTERNAL_EFFECTS=false`. The Worker isolate still rejects
`apply` migrations and real external effects.

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

No `UNAVAILABLE`, `MANUAL_ONLY`, `INFORMATION_ONLY`, or `FUTURE` feature
becomes operational. Email stays sink. SMS stays sink. Twilio is not
wired. Real external effects stay false. `SUAS_ENV=PRODUCTION` stays
rejected. SPEC-018 is not authorized.

## 10. Semantic gaps returned to `SUAS-specs`

1. **ENVIRONMENT.md §3 still forbids a named real email mode.** The Resend
   port cannot be selected without a released mode value and a closed
   provider decision (D-004).
2. **D-006 remains pending.** This record does not classify legal status.
3. **No from-address mailbox is chosen.** Operators set `SUAS_EMAIL_FROM`
   only after a released mode can select Resend.

## 11. Readiness statement

SPEC-017 stays `NOT READY`. SPEC-018 is not authorized. This record does
not claim live email, a Worker deploy, or production operation.
