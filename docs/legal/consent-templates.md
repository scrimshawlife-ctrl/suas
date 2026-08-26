# Draft Consent Grant templates

**Status:** DRAFT / unpublished.
**Authority:** SUAS-specs `CONSENT.md` §2.1 (closed permission/scope pairs), §1, §6, §9.
**Readiness:** SPEC-017 · NOT READY.

Exact template copy is `NOT_COMPUTABLE` until written and published by SUAS-admin (`CONSENT.md` §6). This file drafts veteran-facing text for review. It does **not** publish the templates. Do not ship grants against them. Do not evaluate grants against this file. The implementation still ships no template copy (`src/consent/templates.ts`).

Consent is not a boolean. There is no blanket "I agree." Trusted Circle membership, downloading an app, and notification preferences are not consent. A grant for one scope does not imply another. Purpose vocabulary is not released; these drafts describe the closed permission and scope only.

Last updated 25 Aug 2026 PT. Draft pending counsel review (D-013). Not legal advice.

---

## can_receive + YELLOW

**Status:** DRAFT / unpublished.

You can let a person you choose receive a notice when your Support Signal is YELLOW.

This grant does not let them receive ORANGE or RED notices. It does not let them view your Support Signal details, Check-In answers, current Service Requests, or location.

You can revoke this grant. Trusted Circle membership is not this grant.

---

## can_receive + ORANGE

**Status:** DRAFT / unpublished.

You can let a person you choose receive a notice when your Support Signal is ORANGE.

This grant does not let them receive YELLOW or RED notices. It does not let them view your Support Signal details, Check-In answers, current Service Requests, or location.

You can revoke this grant. Trusted Circle membership is not this grant.

---

## can_receive + RED

**Status:** DRAFT / unpublished.

You can let a person you choose receive a notice when your Support Signal is RED.

This grant does not let them receive YELLOW or ORANGE notices. It does not let them view your Support Signal details, Check-In answers, current Service Requests, or location.

You can revoke this grant. Trusted Circle membership is not this grant.

---

## can_view + support_signal

**Status:** DRAFT / unpublished.

You can let a person you choose view your Support Signal.

This grant does not let them view your Check-In answers, current Service Requests, or location. It does not let them receive notices.

You can revoke this grant. Trusted Circle membership is not this grant.

---

## can_view + checkin_answers

**Status:** DRAFT / unpublished.

You can let a person you choose view your Check-In answers.

This grant does not let them view your Support Signal, current Service Requests, or location. It does not let them receive notices.

You can revoke this grant. Trusted Circle membership is not this grant.

---

## can_view + current_requests

**Status:** DRAFT / unpublished.

You can let a person you choose view your current Service Requests.

This grant does not let them view your Support Signal, Check-In answers, or location. It does not let them receive notices.

You can revoke this grant. Trusted Circle membership is not this grant.

---

## can_view + location

**Status:** DRAFT / unpublished.

You can let a person you choose view a one-time, purpose-scoped location you give for a request — for example a pickup or destination.

This is not continuous GPS. This grant does not let them view your Support Signal, Check-In answers, or current Service Requests. It does not let them receive notices.

You can revoke this grant. Trusted Circle membership is not this grant.

---

## can_share + service_request_fulfillment

**Status:** DRAFT / unpublished.

You can let SUAS share the minimum Service Request data needed for a fulfillment attempt with a Service Provider you select.

This grant does not share Case Notes, Check-In answers, Support Signal basis, or Trusted Circle data. Location still needs its own grant if it is sent.

Selecting a provider is not this grant. Provider terms are not this grant.

You can revoke this grant. Revoking stops future sharing. It does not mean a provider can erase data already sent.
