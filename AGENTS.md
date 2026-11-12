# AGENTS.md

Read [`FABLE_HANDOFF.md`](FABLE_HANDOFF.md) and [`CONTEXT.md`](CONTEXT.md) first. Their hard constraints apply alongside this file.

## Released spec pin

Build against the released `SUAS-specs` stack named in [`src/release/pins.ts`](src/release/pins.ts): currently `SPEC_VERSION` `0.9.0`, manifest `RELEASE_MANIFEST-0.9.0.md` (tag `v0.9.0`). Draft, merged-but-untagged, and unreleased spec text is not authority. The implementation stage is `SPEC-017` (`IMPLEMENTATION_STAGE`), and `PRODUCTION_READINESS` is `NOT_READY`; SPEC-018 is blocked.

## Project

SUAS v1 targets a proof of concept for the Mozilla Human-Scale AI Incubator. The v1 helper model is released in 0.8.0 (D-054) and described in `V1_PROJECT_PLAN.md` (proposal): a Veteran asks for help (food, rides, shelter, peer support) after an ID check, and any signed-in person can accept the request. Crisis destinations and labels come only from `SAFETY_COPY.md` at the pinned release (see Safety and environment).

- This repo: Fastify JSON API `/api/v0` (`src/`), React web app (`web/`, its own package), AWS CDK infrastructure (`infra/`). STAGING runs on AWS (`infra/`), deployed by hand with CDK until a deploy workflow exists ([`docs/runbooks/deployment-rollback.md`](docs/runbooks/deployment-rollback.md)). The Cloudflare Worker and the Neon staging are retired (R11.6, proposal).
- [`SUAS-specs`](https://github.com/scrimshawlife-ctrl/SUAS-specs) at the pinned release is the product authority, including `SAFETY.md` and `ENVIRONMENT.md`. Native clients `suas-ios` and `suas-android` consume `/api/v0`. Do not add `/api/mobile` or a second version selector; HTML `/app/*` commands are the browser surface, not the mobile contract.

## Safety and environment (non-negotiable)

- No automated emergency dispatch, diagnosis, suicide prediction, or safety-critical generative behavior (`SAFETY.md` §2, §6, §8 at the pin).
- Do not add vendor, capacity, SLO, recovery, legal/compliance, partner, staffing, scoring, crisis-copy, or reporting-threshold assumptions that remain unavailable.
- Crisis destinations and labels come only from `SAFETY_COPY.md` at the pinned release. Agents do not add, remove, or relabel them. The `Text 838255` (`sms:838255`) link is D-050, released in `v0.8.0`.
- LOCAL, TEST and STAGING: no real Veteran data and no real external support effects, except allow-listed sandboxes in STAGING (`ENVIRONMENT.md` §2 at the pin). Synthetic data does not make a real provider call allowed.
- TEST and CI keep `SUAS_SAFETY_COPY_MODE=placeholder_test_only` and the fixture and fake adapter modes. Do not switch them.
- No code or config change may silently upgrade an `UNAVAILABLE`, `MANUAL_ONLY`, `INFORMATION_ONLY`, or `FUTURE` feature to production-operational behavior.
- Never commit secrets, `.env`, real contact details, provider credentials, or production data, in code, fixtures, tests, screenshots, or PR text.
- SPEC-018 evidence is required before any production readiness claim. Make no claim of HIPAA compliance or production readiness.
- Pointers at the pin: `SAFETY.md` §2, §6, §8; `ENVIRONMENT.md` §2, §5, §6, §7.

## Spec-driven development

Specs lead; code follows.

1. Read the governing spec in `SUAS-specs` and the docs in this repo (`docs/`, `docs/openapi/v0.json`) before changing behavior.
2. If the spec does not yet describe the change, write it first: open a `SUAS-specs` PR.
3. Open the suas PR citing that spec PR. It stays on HOLD until the spec change is released (tagged) and `pins.ts` is re-pinned, unless the owner states otherwise in writing. Merging a spec PR is not a release.
4. Keep this repo's docs (OpenAPI, READMEs, `CHANGELOG.md`) updated in the same PR as the code.

## Architecture decisions

Contract, schema, auth, and security decisions (public API or contract changes, schema changes, auth and security design) need the owner's written approval and a released spec decision (D-054). The human directing the work decides the other architecture questions: a new service, framework or major library; module boundaries; anything hard to reverse. When one comes up:

1. Stop work on that path.
2. Return the question, the realistic options with their trade-offs, and the code facts with file paths.
3. Wait for the answer, and keep going on independent work meanwhile.

Start implementing that path only once the decision is locked.

## Structure (MVC on the existing layers)

| Layer      | Backend (`src/`)                                    | Frontend (`web/src/`)                     |
| ---------- | --------------------------------------------------- | ----------------------------------------- |
| Model      | domain modules `src/<domain>/`, `src/db/`, adapters | `src/api/` client and generated types     |
| Controller | route handlers `src/http/routes/`                   | TanStack Query hooks, page-level handlers |
| View       | JSON response mapping in routes, `/app` HTML        | React pages and components                |

New code goes into its layer. Domain modules call SUAS-owned ports; provider SDKs stay in adapters. After an `/api/v0` change, update `docs/openapi/v0.json` and run `npm run gen:api` in `web/`.

## Standards

- Work step by step and build exactly what the task asks, completely. Keep changes inside the task's scope: abstractions, features, config and refactors arrive only when the task calls for them.
- SOLID, KISS, DRY, component-based design: small single-purpose units with clear interfaces, composed rather than copied.
- Follow the repo's existing conventions, structure and style.
- Comments: at most 2–3 lines, stating what a function, class, module or test is for and why. Leave the code to say what it does; delete code instead of commenting it out.
- Format after every code change: `npx prettier --write <changed files>` (config in `.prettierrc.json`).

## Verify with graphify

Check every project fact before relying on it. `graphify-out/` is git-ignored, so build the graph locally: run `/graphify .` once, then `/graphify . --update` after pulling. Query it (`/graphify query "<question>"`), then read the source it points to. Report any fact you could not verify.

## Workflow

1. Understand the task and list the acceptance criteria you will be judged against.
2. Verify the facts (graphify, then the source) and the spec.
3. Lock the architecture decisions with the human.
4. Branch, implement fully, run Prettier on the changed files, then test.
5. Commit each finished set of changes before starting the next.

By kind of task:

- **Feature:** follow the `feature-dev:feature-dev` phases: discovery, codebase exploration, clarifying questions, architecture, implementation, review.
- **Bug fix or patch:** confirm the cause in the real code first, fix it, then prove the fix with a test.
- **Large task** (more than one session): apply the `wayfinder` method from the mattpocock-skills plugin (`skills/engineering/wayfinder/SKILL.md`): name the destination, break the work into decisions, resolve the small ones, escalate the architectural ones, then build in slices.

Matt Pocock skills (`mattpocock-skills:*`) for the end-to-end flow: `grilling` and `domain-modeling` to settle the design, `codebase-design` for module shape, `prototype` for throwaway spikes, `research` for primary sources, `diagnosing-bugs` for hard bugs (write its regression test after the fix), `code-review` before a PR, `pr` for the PR body, `writing-for-agents` when editing this file.

## Testing

Implement first; test after.

- Write only the crucial tests: the ones that prove the requirement and its key edge cases, for code you changed, and keep `npm run verify` and CI green.
- The `SAFETY.md` red-state critical suite and the `TESTING.md` safety gate tests always run; they are never optional.
- Web behavior: drive it with the Playwright browser tools. Use the `chrome-devtools-mcp:chrome-devtools` skill for console errors, network requests and performance, and `claude-in-chrome` when the test needs a real browser session. Browser testing targets LOCAL or synthetic STAGING only, never real accounts or production.
- When a test fails, fix the code. If CI or a test looks wrong, open a labeled defect (`bug`); do not edit tests to force green. Never delete or weaken a test without a human's sign-off. Report failures you could not resolve, with their output.
- Run `npm run verify` (root) and `npm run check` (`web/`, `infra/`) before pushing. One test: `npx vitest run <path> -t "<name>"`.
- Tooling: npm and the existing `package.json` scripts; run the Python checks (`scripts/validate-skills.py`, `tests/test_skill_metadata.py`) with `uv`.

## Git

- Create a branch before changing code; commit only on that branch, never on `main`.
- Branches: `feature_<desc>`, `bugfix_<desc>`, `patch_<desc>`, `misc_<desc>` (docs, config, tooling), lowercase.
- Commits: 5–7 files at most. A one-line summary, then short bullets with one change each.
- PRs: at most 5 commits and 25–35 changed files. Split larger work into stacked PRs. Open a PR only when asked.
- Commit messages, PR titles and bodies, and branch names credit only the human contributor: no AI co-author trailers.
- Merge only after the owner's OK. Do not tag without the owner's yes; follow [`RELEASING.md`](RELEASING.md).
- Do not add an SDLC `HANDOFF.md` in this repository.

## Report

End every task with:

- **Done:** what was implemented or fixed, against each acceptance criterion
- **Files:** created and modified paths
- **Branch:** name, and commit or PR if any
- **Tests:** what ran and the results, with the output of any failure
- **Unverified:** any fact you could not confirm
- **Needs your decision:** any escalated architecture question, with its options
