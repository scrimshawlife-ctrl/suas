# D-006 counsel fact sheet

**Status:** DRAFT for counsel. Not legal advice. Not a certification. D-006 remains pending.
**Readiness:** SPEC-017 · NOT READY. UI_CONFORMANCE, SPEC-018, and PRIVACY stay NOT READY.
**Last updated:** 26 Aug 2026 PT
**Authority:** SUAS-specs `COMPLIANCE.md` §1–§5, §8, §11; `DECISIONS.md` D-001–D-008, D-013; `SECURITY.md`; `PRIVACY.md`; `SAFETY.md` §2; 45 CFR 160.103.

This file is the source of truth for [`docs/d006.html`](../d006.html). It lists product facts for counsel. It is not a certification.

---

Counsel owns whether SUAS is a HIPAA covered entity, a business associate, or neither (D-006). That decision is not made. This page lists product facts for that review. It does not say a health-privacy statute applies. It does not say it does not apply. It is not a HIPAA authorization and not a BAA.

THIS PAGE DOES NOT MAKE SUAS HIPAA-COMPLIANT, CCPA-COMPLIANT, TCPA-COMPLIANT, OR ANYTHING-COMPLIANT.

---

## HHS classification facts

HHS publishes the definitions. Cite 45 CFR 160.103.

- A covered entity (CE) is a health plan, a clearinghouse, or a provider that does standard electronic transactions.
- A business associate (BA) handles PHI for a CE.
- If an entity is neither, HHS says the HIPAA Rules do not apply.

Do not conclude which box SUAS is in.

HHS pages:

- [Covered entities](https://www.hhs.gov/hipaa/for-professionals/covered-entities/index.html)
- [Business associates](https://www.hhs.gov/hipaa/for-professionals/privacy/guidance/business-associates/index.html)
- [Sample business associate agreement provisions](https://www.hhs.gov/hipaa/for-professionals/covered-entities/sample-business-associate-agreement-provisions/index.html)
- [Security Rule](https://www.hhs.gov/hipaa/for-professionals/security/laws-regulations/index.html)

---

## Observed facts

Do not treat this list as a legal class.

- zer0state builds SUAS. Legal entity on this site: **Zero State LLC**, 30 N Gould St Ste R, Sheridan, WY 82801. Email zer0state@zer0state.com. The Wyoming address is a registered-agent mailing, not an operations claim.
- This Pages site is a poster. Operations are not live. Status: **SPEC-017 · NOT READY**.
- Intended later use (not authorized): identified opt-in veteran coordination (Check-In, Support Signal in fixture or disabled mode, QRF / Support Case). SUAS is not an EHR. It does not diagnose. It does not predict suicide. It does not call 911. It is not a VA health API. It is not Medi-Cal billing.
- Specs name a Santa Clara County 25–50 veteran pilot. That pilot is not authorized. D-008 and D-013 are open.
- Product rules already specified (not a HIPAA conclusion): TLS; database and backup encryption (key management is open); role and tenant isolation; privileged MFA; audit events; minimization; consent at use time; no production data in development environments; UI forbids compliance-claim strings.
- D-007 has a synthetic STAGING-only operating decision, but production retention, purge/export, and legal obligations are not decided. This counsel-facing page does not publish the synthetic duration or project it into a production or HIPAA claim.
- Vendors for host, auth, SMS, email, and production database are not selected (D-001–D-005).
- Do not execute a BAA as if HIPAA applies until D-006 closes. Written data-processing terms with vendors are an operational control, not a legal class.

---

## Ask of counsel

Classify SUAS as one of the following:

- Covered entity (CE)
- Business associate of a named covered entity
- Neither
- Evidence insufficient

---

## If counsel later records that HIPAA applies

This section is not in force now.

If counsel later records that HIPAA applies:

- Business associate agreements for relevant vendors
- Security Rule risk analysis and policies
- Breach-notice counsel
- If SUAS is a covered entity: a Notice of Privacy Practices and an individual-rights process

This sheet does not name a statutory deadline.

---

## 42 CFR Part 2

42 CFR Part 2 stays out of scope unless substance-use-disorder (SUD) treatment records are later specified.

---

## Status of this sheet

Last updated 26 Aug 2026 PT.

This is a draft for counsel. It is not legal advice. It is not a certification. D-006 remains pending. SPEC-017 remains NOT READY. UI_CONFORMANCE remains NOT READY. SPEC-018 remains NOT READY. The PRIVACY gate remains NOT_READY. No readiness gate advances because this sheet exists.
