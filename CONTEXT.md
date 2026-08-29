# CONTEXT.md — SUAS implementation context

Read this before implementation work.

## What SUAS is

Shut Up and Serve is a consent-governed veteran support coordination platform.

Mission: coordinate the shortest safe and consented path between a veteran's current need and an available human or material support resource.

Canonical loop:

`SIGNAL → NEED → CONSENT → COORDINATION → FULFILLMENT → FOLLOW-UP → SETTLEMENT`

MVP categories:

- `FOOD`
- `TRANSPORTATION`
- `SHELTER` — temporary shelter/accommodation, not permanent housing
- `PEER_SUPPORT`

## What SUAS is not

- EHR
- diagnosis system
- suicide-prediction product
- automated emergency-dispatch system
- clinical efficacy measurement product
- production billing/Medi-Cal system

## Canonical repositories

- Specs: `scrimshawlife-ctrl/SUAS-specs`
- Implementation: `scrimshawlife-ctrl/SUAS`

Specs are authority. Implementation gaps return to specs.

## Released implementation contract

- spec version: `0.2.0`
- implementation authority: `RELEASED_FOR_IMPLEMENTATION`
- current implementation stage: `SPEC-017`
- production/pilot readiness: `NOT_READY`

Use `FABLE_HANDOFF.md`, `AGENTS.md`, and `SPEC017_PLAN.md` in this repo, then the released `HANDOFF.md` and `ENVIRONMENT.md` in `SUAS-specs`.

## Current handoff state · 2026-08-29

The repository contains a **synthetic-STAGING evidence packet only**. It is not a pilot or production release, and it has no real-world effects.

- Evidence packet root: `docs/readiness/evidence/synthetic-staging-2026-08-29/`.
- D-007 implementation and evidence commits: `398601e`, `e306f87`, `31303cd`, and `0a73017`.
- The D-007 stage-1 owner record is deliberately `DEFER_REQUIRED` at `docs/readiness/evidence/synthetic-staging-2026-08-29/d007/pre-execution/owner-decision-defer-required.md`.
- No D-007 dry run has executed. Do not convert the record to `ACCEPT` or run it without a complete accountable owner identity, selected decision, owner-generated UTC signing timestamp, positively identified synthetic-STAGING deployment ID, and independent verification of every frozen hash.
- Stage 2 evidence acceptance is separate from Stage 1 authorization. Its template is `d007/pre-execution/post-execution-acceptance-template.md`.
- The former shared-account Cloudflare Workers host is retired for SUAS. Do not use it for browser acceptance, deployment evidence, VA OAuth callback registration, or any new integration. A new independently owned SUAS Cloudflare account/subdomain or custom staging hostname must be provisioned outside the repository before STAGING deployment work resumes.
- Browser acceptance has no committed hostname default. Its `SUAS_E2E_BASE_URL` and deployment credentials belong only in GitHub Environment `suas-synthetic-staging` after the independent hostname is provisioned and verified.

The following controls remain mandatory and must stay unchanged absent separate authorization:

```text
D007_DELETION_EXECUTION=disabled
D007_EXPORT_DELIVERY=disabled
D007_365_DAY_PURGE=disabled
D025_REPORTING=disabled
REAL_WORLD_EFFECTS=disabled
PILOT_LAUNCH=blocked
PRODUCTION_LAUNCH=blocked
```

### Machine and platform handoff

- Remote: `origin` → `https://github.com/scrimshawlife-ctrl/suas.git`.
- Default branch: `main`. This branch contains the handoff packet as a pull request candidate and must be reviewed before merge.
- Preserve unrelated working-tree files `.gitignore` and `.ignore`. They pre-date this handoff and are not part of the evidence packet.
- On a new machine: clone the repository, fetch `origin`, check out the pull-request branch, run `npm ci`, then run `npm run evidence:preflight` and the targeted D-007 tests before reviewing or continuing.
- Never place secrets, deployment credentials, personal data, or real provider configuration in this repository or its evidence packet.

## Architecture

Default architecture is a scalable modular monolith with:

- stateless application instances;
- PostgreSQL logical system of record;
- durable async-work abstraction;
- persistent command idempotency;
- replay-safe Domain Events;
- provider-neutral capability ports;
- Manual/Fake adapters before real provider adapters;
- strict tenant isolation;
- bounded/paginated growing APIs.

## Core domain distinctions

Do not alias:

- Check-In ≠ Support Signal
- Support Case ≠ Service Request
- Referral ≠ Service Request
- Assignment ≠ Fulfillment
- Fulfillment Attempt ≠ Fulfillment
- Follow-Up ≠ Case Note
- Settlement ≠ Fulfillment or clinical outcome

## UX reference

The existing SUAS MVP is the visual/interaction reference. Preserve its action-first veteran/QRF/resource/responder/admin experience. Required production divergences include truthful availability, no unsupported proximity guarantee, no continuous GPS requirement, no hidden future-category workflow, and no unapproved safety copy.

## Current production-unavailable surfaces

Do not make operational by implementation default:

- real production infrastructure/provider side effects;
- real veteran data/live pilot;
- production Support Signal scoring;
- official safety/crisis copy;
- real external transportation/shelter/food/peer provider adapters;
- production SLO/RTO/RPO targets;
- sensitive aggregate reporting.

## Engineering rule

Prefer the simplest implementation mechanism that proves the released invariant. Do not introduce distributed-system complexity without measured need and a released spec change.
