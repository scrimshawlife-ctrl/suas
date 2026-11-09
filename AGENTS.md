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

Discuss each architecture decision with the human directing the work: lay out the options, their trade-offs and the code facts with file paths. Start implementing only once the decisions are locked. Architecture includes a new service or library, schema changes, public API changes, module boundaries, auth and security design, and anything hard to reverse.

## Structure (MVC on the existing layers)

| Layer      | Backend (`src/`)                                    | Frontend (`web/src/`)                     |
| ---------- | --------------------------------------------------- | ----------------------------------------- |
| Model      | domain modules `src/<domain>/`, `src/db/`, adapters | `src/api/` client and generated types     |
| Controller | route handlers `src/http/routes/`                   | TanStack Query hooks, page-level handlers |
| View       | JSON response mapping in routes, `/app` HTML        | React pages and components                |

New code goes into its layer. Domain modules call SUAS-owned ports; provider SDKs stay in adapters. After an `/api/v0` change, update `docs/openapi/v0.json` and run `npm run gen:api` in `web/`.

## Standards

- SOLID, KISS, DRY, component-based design: small single-purpose units with clear interfaces, composed rather than copied.
- Build exactly what the task asks, completely. Follow the repo's existing conventions.
- Comments: at most 2–3 lines, stating what a function, class, module or test is for and why.

## Verify with graphify

Check every project fact before relying on it. `graphify-out/` is git-ignored, so build the graph locally: run `/graphify .` once, then `/graphify . --update` after pulling. Query it (`/graphify query "<question>"`), then read the source it points to. Report any fact you could not verify.

## Workflow

Follow `~/.claude/agents/dev-agent.md` where it exists; this file wins on conflict.

1. Understand the task and list its acceptance criteria.
2. Verify the facts (graphify, then the source) and the spec.
3. Lock the architecture decisions with the human.
4. Branch, implement fully, then test.
5. Commit each finished set of changes before starting the next.

Matt Pocock skills (`mattpocock-skills:*`) for the end-to-end flow: `grilling` and `domain-modeling` to settle the design, `codebase-design` for module shape, `prototype` for throwaway spikes, `research` for primary sources, `diagnosing-bugs` for hard bugs (write its regression test after the fix), `code-review` before a PR, `pr` for the PR body, `writing-for-agents` when editing this file.

## Testing

Implement first; test after.

- Write only the crucial tests: the ones that prove the requirement and its key edge cases, and keep `npm run verify` and CI green.
- Web behavior: drive it with the Playwright browser tools.
- When a test fails, fix the code; change a test only when the test itself is wrong.
- Run `npm run verify` (root) and `npm run check` (`web/`, `infra/`) before pushing. One test: `npx vitest run <path> -t "<name>"`.

## Git

- Branches: `feature_<desc>`, `bugfix_<desc>`, `patch_<desc>`, `misc_<desc>` (docs, config, tooling), lowercase.
- Commits: 5–7 files at most. A one-line summary, then short bullets with one change each.
- PRs: at most 5 commits and 25–35 changed files. Split larger work into stacked PRs.
- Author lines and messages name only the human contributor.
- Merge only after the owner's OK.
