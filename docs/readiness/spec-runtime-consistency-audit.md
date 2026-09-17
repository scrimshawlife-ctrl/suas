# Spec / runtime consistency audit

Living pin row audited 2026-09-17. Historical D-011 identity stays `0.2.0`.

| Pin            | Runtime                                           | Specs                     | Status                                               |
| -------------- | ------------------------------------------------- | ------------------------- | ---------------------------------------------------- |
| Spec stack     | `SUAS_SPEC_VERSION=0.6.0` (`src/release/pins.ts`) | RELEASE_MANIFEST-0.6.0.md | Aligned 2026-09-17                                   |
| API selector   | `/api/v0`                                         | API.md §2                 | Aligned                                              |
| Questionnaire  | `qv-001` required at scoring                      | SIGNAL_SCORING.md B5      | Aligned (#59)                                        |
| Signal version | `sv-001`                                          | D-011 / released at 0.2.0 | Aligned; inherited by 0.6.0                          |
| Safety copy    | D-012 destinations only                           | SAFETY_COPY.md            | Aligned                                              |
| Job durability | fail-closed STAGING/PROD                          | ARCHITECTURE.md §8 D-022  | Aligned (pending owner product)                      |
| OpenAPI        | `docs/openapi/v0.json`                            | draft APIS.md             | Documents implemented only; draft paths not invented |

No silent product-rule invention found in this sprint’s API projections.
