# Public Privacy Notice

**Status:** DRAFT. Pending counsel review (D-013). Not legal advice.
**Readiness:** SPEC-017 · NOT READY. The PRIVACY gate stays NOT_READY.
**Last updated:** 25 Aug 2026 PT
**Authority:** SUAS-specs `PRIVACY.md`, `CONSENT.md`, `COMPLIANCE.md`, `SECURITY.md`, and `SAFETY.md` on released stack `0.2.0` (`RELEASE_MANIFEST-0.2.0.md`).

This file is the source of truth for [`docs/privacy.html`](../privacy.html). It is a public notice, not a certification.

---

## In short

SUAS is built by **zer0state** (Zero State LLC). It coordinates practical support for veterans. It is not live operations. Status: **SPEC-017 · NOT READY**.

This public Pages site collects as little as possible. We do not add tracking pixels. We do not sell data from these pages.

If you later enroll, we collect only what the coordination loop needs: your account and session, Check-Ins, Consent Grants, Support Cases and Service Requests you create, Trusted Circle contacts you add, and a one-time pickup or destination when a transportation request needs it.

We do not collect Social Security numbers, medical history, diagnoses, DD-214 dumps, continuous GPS, or your full device contact list.

You can grant or revoke consent. You can request an export. You can request deletion. Export package format is not decided. Retention durations are not decided (D-007). A deletion request is a recorded process, not a promised deadline.

Draft pending counsel review (D-013). Not legal advice. Last updated 25 Aug 2026 PT.

---

## Who we are

zer0state builds SUAS (Shut up and serve).

Legal entity: **Zero State LLC**, 30 N Gould St Ste R, Sheridan, WY 82801.

Contact: zer0state@zer0state.com

That Wyoming address is a registered-agent mailing and legal home. It is not a claim that operations run there.

---

## What this product is

SUAS is a consent-governed veteran support coordination system. It aims to coordinate the shortest safe and consented path between a current need and an available human or material support resource.

Canonical loop: SIGNAL → NEED → CONSENT → COORDINATION → FULFILLMENT → FOLLOW-UP → SETTLEMENT.

MVP categories: FOOD, TRANSPORTATION, SHELTER (temporary, not permanent housing), and PEER SUPPORT.

This public site is a hackathon entry for the Veteran Innovation Hackathon at Hacker Dojo, 28–30 Aug 2026. Implementation lives in the repository. **Operations are not live.** SPEC-017 is NOT READY.

SUAS is not a medical, mental-health, legal, or emergency service. It does not call 911. It does not diagnose. It does not replace VA, county, or 988 services.

---

## What we collect

### This public Pages site

These pages should collect as little as possible. We do not add tracking pixels, analytics tags, or sale of data on this site. Visiting these pages does not enroll you.

### If you later enroll

If enrollment opens later, we collect only fields a specified workflow needs (PRIVACY.md §2 minimization):

- Account and session data needed to sign you in and keep the session revocable.
- Check-Ins you complete.
- Consent Grants you issue or revoke.
- Support Cases and Service Requests you create, and the Follow-Up and Settlement fields written for you.
- Trusted Circle contacts you add.
- A one-time, purpose-scoped location — for example a pickup or destination on a TRANSPORTATION request — only when that request needs it.

Sensitive free text (notes, Check-In free text) is stored and access-logged. It is not written to ordinary application logs.

---

## What we do not collect by default

Unless a later released workflow requires it, we do not collect:

- Social Security numbers
- Medical history
- Diagnoses
- DD-214 or other service-record dumps
- Continuous GPS or background location
- Full device contact lists
- Device telemetry beyond what sign-in and session security require

Location is one-time and purpose-scoped. Continuous tracking is out of scope.

---

## Why we collect it

We use this data to run the canonical loop: SIGNAL → NEED → CONSENT → COORDINATION → FULFILLMENT → FOLLOW-UP → SETTLEMENT.

Purpose limitation: we use data only for the purpose recorded on the Consent Grant or a documented system basis (PRIVACY.md §2). We do not sell data. We do not use it for secondary research.

---

## Who we share with

- **Responders on assignment** see what an active assignment requires. Assignment is not Trusted Circle membership.
- **Trusted contacts** see or receive only what a matching Consent Grant allows, evaluated at the time of use. Membership is not consent.
- **Service Providers** receive only a minimum projection after a matching grant, never a whole Support Case by default.

We do not sell your data. We do not share it for sale. We do not use it for secondary research.

A prior disclosure does not authorize a later one. If a provider is replaced, consent is evaluated again for the new party.

We do not claim that a provider erases copies we already sent. Provider-side copies are not computable here (PRIVACY.md §10).

---

## Retention and deletion

Retention durations are not decided (D-007). We do not invent days or months.

Until that decision lands:

- We soft-delete operational rows when access is revoked.
- We keep Audit Event and Domain Event history. We do not purge that history.
- Consent history is preserved. A revoked grant is not rewritten as if it never existed.
- A deletion request is recorded. It is fulfilled only to the extent a later spec allows after D-007.
- We do not claim provider-side erasure.

---

## Your choices

Consent is not a checkbox that unlocks everything (CONSENT.md §1, §9).

- You grant and revoke purpose-scoped Consent Grants. Each grant is evaluated at use time.
- Membership in a Trusted Circle is not consent. Downloading an app is not consent. Notification preferences are not consent.
- There is no blanket "I agree" that opens every scope.
- You may request an export of your own veteran-visible data. Package format is not decided.
- You may request deletion. That request is a recorded process. We do not invent a deadline or SLA.

To ask for an export or deletion, write to zer0state@zer0state.com. Operations are not live, so these requests are recorded against a system that is not yet serving veterans.

---

## California

We treat CCPA/CPRA as relevant for a Santa Clara County pilot geography. That is an inference from geography, not a counsel opinion and not a claim that we meet that law.

We do not sell personal information. We do not share it for sale.

Export format and deletion durations remain open, as above.

---

## Health information

Counsel owns legal classification (D-006). That decision is still pending.

We do not say that a health-privacy statute applies. We do not say that it does not apply. We treat veteran support data as highly sensitive either way (PRIVACY.md §1; SECURITY.md §1; COMPLIANCE.md §2–§3).

This notice is not a health-information authorization and not a business-associate agreement.

---

## Security

At a high level, the released controls include:

- TLS for data in transit
- Access control by role, tenant, row, and consent or documented system basis
- Immutable audit of sensitive reads and disclosures

We do not put secrets in these pages. We do not show sample veteran data here.

---

## How to reach us

Zero State LLC
30 N Gould St Ste R
Sheridan, WY 82801

zer0state@zer0state.com

---

## Status of this notice

Last updated 25 Aug 2026 PT.

This is a draft notice pending counsel review (D-013). It is not legal advice. It is not a certification. SPEC-017 remains NOT READY. The PRIVACY gate remains NOT_READY. No readiness gate advances because this notice exists.
