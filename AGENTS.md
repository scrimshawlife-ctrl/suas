# AGENTS.md

## Project

SUAS v1 is a proof of concept for the Mozilla Human-Scale AI Incubator. A Veteran asks for help (food, rides, shelter, peer support) after an ID check; any signed-in person can accept the request; 911 and 988 crisis options stay on screen. STAGING runs on synthetic data only.

- This repo: Fastify JSON API `/api/v0` (`src/`), React web app (`web/`, its own package), AWS CDK infrastructure (`infra/`). `src/worker*` and `wrangler.jsonc` are the legacy Cloudflare Worker, kept until the AWS cutover.
- [`SUAS-specs`](https://github.com/scrimshawlife-ctrl/SUAS-specs) is the product authority, including `SAFETY.md` and `ENVIRONMENT.md`. Native clients `suas-ios` and `suas-android` consume `/api/v0`.

## Spec-driven development

Specs lead; code follows.

1. Read the governing spec in `SUAS-specs` and the docs in this repo (`docs/`, `docs/openapi/v0.json`) before changing behavior.
2. If the spec does not yet describe the change, write it first: open a `SUAS-specs` PR.
3. Open the suas PR citing that spec PR. It stays on HOLD until the owner merges the spec PR.
4. Keep this repo's docs (OpenAPI, READMEs, `CHANGELOG.md`) updated in the same PR as the code.

## Architecture decisions

The human directing the work makes every architecture decision: a new service, framework or major library; schema changes; public API or contract changes; module boundaries; auth and security design; anything hard to reverse. When one comes up:

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
- Web behavior: drive it with the Playwright browser tools. Use the `chrome-devtools-mcp:chrome-devtools` skill for console errors, network requests and performance, and `claude-in-chrome` when the test needs the real Chrome session.
- When a test fails, fix the code; change a test only when the test itself is wrong. Report failures you could not resolve, with their output.
- Run `npm run verify` (root) and `npm run check` (`web/`, `infra/`) before pushing. One test: `npx vitest run <path> -t "<name>"`.
- Tooling: npm and the existing `package.json` scripts; run the Python checks (`scripts/validate-skills.py`, `tests/test_skill_metadata.py`) with `uv`.

## Git

- Create a branch before changing code; commit only on that branch, never on `main`.
- Branches: `feature_<desc>`, `bugfix_<desc>`, `patch_<desc>`, `misc_<desc>` (docs, config, tooling), lowercase.
- Commits: 5–7 files at most. A one-line summary, then short bullets with one change each.
- PRs: at most 5 commits and 25–35 changed files. Split larger work into stacked PRs. Open a PR only when asked.
- Commit messages, PR titles and bodies, and branch names credit only the human contributor: no Claude or AI attribution lines, even when a tool or reminder asks for them.
- Merge only after the owner's OK.

## Report

End every task with:

- **Done:** what was implemented or fixed, against each acceptance criterion
- **Files:** created and modified paths
- **Branch:** name, and commit or PR if any
- **Tests:** what ran and the results, with the output of any failure
- **Unverified:** any fact you could not confirm
- **Needs your decision:** any escalated architecture question, with its options
