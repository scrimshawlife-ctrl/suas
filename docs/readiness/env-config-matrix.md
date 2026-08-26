# Environment / configuration matrix

| Variable                           | LOCAL                 | TEST            | STAGING                   | PRODUCTION                         |
| ---------------------------------- | --------------------- | --------------- | ------------------------- | ---------------------------------- |
| `SUAS_ENV`                         | required              | required        | required                  | rejected until SPEC-018 authorizes |
| `SUAS_SPEC_VERSION`                | `0.2.0`               | `0.2.0`         | `0.2.0`                   | `0.2.0` when authorized            |
| `SUAS_ALLOW_REAL_EXTERNAL_EFFECTS` | false                 | false           | false                     | only if release authorizes         |
| Job queue                          | in-memory fake        | in-memory fake  | fail-closed (D-022)       | fail-closed (D-022)                |
| `SUAS_SUPPORT_SIGNAL_MODE`         | fixture/disabled      | fixture         | fixture or released       | released only                      |
| `SUAS_SAFETY_COPY_MODE`            | placeholder           | placeholder     | approved when reviewed    | approved                           |
| Migrations                         | apply/validate        | apply in CI     | explicit apply in runbook | explicit; never implied            |
| Session secret                     | required when auth on | generated in CI | secret store              | secret store                       |

Source of truth: `src/config/schema.ts` + ENVIRONMENT.md.
