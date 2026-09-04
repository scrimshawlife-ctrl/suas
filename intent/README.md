# intent/ — SDLC intent records

**Kind:** process. Not a release artifact. Not implementation authority. Closes no D-0xx. Does not define complete.

This repository is the web and API implementation (`/api/v0`, HTML `/app`). [`SUAS-specs`](https://github.com/scrimshawlife-ctrl/SUAS-specs) is canonical.

- **Product / domain intents** belong in [`scrimshawlife-ctrl/SUAS-specs` `intent/`](https://github.com/scrimshawlife-ctrl/SUAS-specs/tree/main/intent). Copy the template there. Do not invent product or domain rules in this repository.
- **Implementation-only intents** (Worker/API/web conformance, tests, infra, adapter seams the release already permits, docs process) start here. Copy [`_TEMPLATE.md`](_TEMPLATE.md) to a dated file (`YYYY-MM-DD-short-slug.md`). Fill every section. Label claims with the epistemic set in [AGENTS.md](../AGENTS.md).

## Sequence

`intent.md` → product/domain `spec.md` in `SUAS-specs` (must include `## Workflows`) when the change is a contract gap → plan → implement.

Plan and implement in this repository must cite released specs. Native clients ([`suas-ios`](https://github.com/scrimshawlife-ctrl/suas-ios), [`suas-android`](https://github.com/scrimshawlife-ctrl/suas-android)) stay in scope when `/api/v0`, auth, environment class, or a Veteran journey changes.

Clarifications that do not change behavior may skip this sequence.

## Holds

- The existing [FABLE_HANDOFF.md](../FABLE_HANDOFF.md) hold still applies: do not define complete.
- Do not add an SDLC `HANDOFF.md` in this repository. The released implementation handoff stays at repository root.
- An intent is not a spec, not a plan, and not a release. It does not authorize implementation, pilot, production, or a Worker publish.
- Semantic gaps stay labeled and return to `SUAS-specs`. Do not invent product or domain rules here.
