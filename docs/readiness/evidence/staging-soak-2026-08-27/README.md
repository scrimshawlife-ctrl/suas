# STAGING soak evidence — 2026-08-27

**Host:** `RETIRED_SHARED_ACCOUNT_HOST_DO_NOT_USE`
**Class:** `SUAS_ENV=STAGING` (formal synthetic)  
**Data:** Neon synthetic seed (`npm run seed`); bearers from gitignored seed summary  
**Effects:** false (email/SMS sink; adapters fake/manual)

**Topology status:** Retired. The captured host shared another product's
Cloudflare workers.dev identity and cannot support current SUAS STAGING,
acceptance, or OAuth callback claims. Re-run this soak only after an independent
SUAS host is provisioned and approved.

## Health

From `soak-summary.json`:

- `status: ok`
- `database: configured`
- `job_queue.durability: durable`
- `job_queue.implementation: postgres-outbox`

## Route matrix

17 routes × 5 attempts = **85/85 HTTP 200** (HTML + JSON). See `soak-summary.json` → `routeMatrix`.

Covered:

- Public: `/app`, `/api/v0/health`
- Veteran: home, notifications, preferences, consents, trusted-contacts, resources, food, immediate-resources
- Responder: queue, case detail, availability
- JSON: resources, notifications, consents, unassigned cases

## Jobs

`npm run jobs:work -- --once --limit 5` → exit **0** (`jobs-work-once.log`). Empty queue is success for this soak.

## Claim boundary

- **Not PRODUCTION.** Not SPEC-018.
- Does not flip AUTH/CONSENT/CHECK-IN/COORDINATION/OPERATIONS to READY by itself — those may still want abuse-SLO / human policy notes — but **shared STAGING soak evidence is now pinned**.
- SAFETY still on `placeholder_test_only` until approved-copy checklist.
