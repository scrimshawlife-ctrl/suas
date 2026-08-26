# Decision packet — D-022 Production durable job/queue implementation

**Status:** OWNER_DECISION_REQUIRED  
**Affects gates:** `RESILIENCE`, `OPERATIONS`, `COORDINATION` (async settlement path)  
**Blocks:** STAGING/PRODUCTION process start (already fail-closed); durable recovery evidence

## Exact question

Which durable job/queue product should SUAS use in STAGING and PRODUCTION for production-critical async work (Support Signal compute, notification delivery, follow-up sweeps)?

## Released constraints

- ARCHITECTURE.md §3 invariant 5: production-critical async work survives process/worker restart.
- ARCHITECTURE.md §8 / §16: volatile process-local production queues are a non-goal; exact product is D-022.
- ENVIRONMENT.md §4–§5: LOCAL/TEST may use a declared fake; STAGING/PRODUCTION must fail closed until a durable implementation is selected and released.
- Provider SDKs stay behind SUAS-owned ports; no silent vendor default.

## Viable options

1. **Managed queue service** (e.g. cloud SQS/PubSub + worker) — durable, ops-owned SLOs, vendor lock-in.
2. **Postgres-backed outbox / SKIP LOCKED worker** — same database as correctness-critical state; operationally simple; requires careful poll/lease design.
3. **Self-hosted Redis/BullMQ-class worker** — familiar DX; durability depends on Redis persistence and ops discipline.

## Recommended option (non-binding)

**Option 2 — Postgres-backed outbox** for the first durable cut: one operational store, tenant-scoped rows, natural fit for existing migration/backup posture. Revisit managed queue if volume or multi-region needs appear.

## Tradeoffs

| Option          | Pros                                 | Cons                                      |
| --------------- | ------------------------------------ | ----------------------------------------- |
| Managed         | Durability/ops mature                | New vendor + IAM; D-022 + possibly D-001  |
| Postgres outbox | No new system; backup/RPO tied to DB | Worker ops; poll latency                  |
| Redis/Bull      | Fast DX                              | Extra persistence story; split brain risk |

## Reversibility

High if the `DurableJobQueuePort` seam stays the only enqueue API (already true). Vendor SDKs must not leak into domain modules.

## Required owner action

1. Choose option 1/2/3 (or name another).
2. Authorize a specs release note / manifest update that names the product.
3. Confirm STAGING may run the durable implementation with synthetic data only.

## Work already completed independently of the decision

- `DurableJobQueuePort` seam (`src/jobs/port.ts`)
- In-memory non-durable fake for LOCAL/TEST
- Factory fail-closed for STAGING/PRODUCTION citing D-022
- Dispatching wrapper for Check-In → `support-signal.compute` in TEST
- Port conformance suite (`assertJobPortConformance`) any future durable adapter must pass
- `/api/v0/health` reports queue durability/implementation without secrets
