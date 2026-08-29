# SUAS runtime skill router

Read repository-root `SKILLS.md` for the full runtime skill catalog and execution order. Load the specialized skill below when its trigger matches the task.

| Skill | Load |
|---|---|
| Readiness/evidence/feature-enablement gates | [`evidence-gate/SKILL.md`](evidence-gate/SKILL.md) |
| Deterministic contract/scoring conformance | [`contract-validation/SKILL.md`](contract-validation/SKILL.md) |
| Executable synthetic fixtures | [`synthetic-data/SKILL.md`](synthetic-data/SKILL.md) |
| Backup/restore execution | [`recovery-test/SKILL.md`](recovery-test/SKILL.md) |
| Negative/fail-closed runtime tests | [`adversarial-testing/SKILL.md`](adversarial-testing/SKILL.md) |
| Built-surface accessibility evidence | [`accessibility-audit/SKILL.md`](accessibility-audit/SKILL.md) |

## Routing rule

1. Read `CONTEXT.md` and `AGENTS.md` first.
2. Resolve released spec/manifest and current runtime provenance.
3. Load every specialized skill whose trigger applies; skills may compose.
4. Runtime skills execute and capture evidence but cannot override `SUAS-specs` authority.
5. Semantic ambiguity returns to `SUAS-specs`; missing evidence returns `NOT_COMPUTABLE` or the governing pending state.