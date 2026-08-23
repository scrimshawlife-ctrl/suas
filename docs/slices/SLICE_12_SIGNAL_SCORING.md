# Slice 12 — D-011 Support Signal scoring (`qv-001` + `sv-001`)

**Released spec stack:** `0.2.0`
**Release manifest:** `RELEASE_MANIFEST-0.2.0.md`
**Specs merge:** `4a722e69ad8f7ff45a9581ca3bdd022bdf524f8f`
**Decision ledger:** `RELEASE_DECISIONS-0.2.0.md`
**Stage:** `SPEC-017`
**Production/pilot readiness:** `NOT_READY` (unchanged)

Scope is the v0.2.0 re-pin plus a `released: true` engine transcribed from
`SIGNAL_SCORING.md`. Slice 9 already shipped the interface, computation identity,
settlement, and empty registry. This slice fills that registry from the released
tables. It does not invent weights, open Support Cases from signals (G-I-28),
change `/api/v0` or event schema `0.1.0`, or advance any readiness gate.

## 1. Released spec citations

| Spec                         | Sections relied on                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `SIGNAL_SCORING.md`          | B1 questionnaire and option weights; B2 ordered rules; B3 incomplete input; B4 GV-001–GV-014; B5 version identities |
| `RELEASE_MANIFEST-0.2.0.md`  | Runtime pins; readiness boundary; not-closed list including G-I-28                                                  |
| `RELEASE_DECISIONS-0.2.0.md` | D-011 `DECIDED` for `qv-001` + `sv-001`                                                                             |
| `SUPPORT_SIGNALS.md`         | §1 values; §2 computation contract; §3 identity; §10 non-goals                                                      |
| `CHECKINS.md`                | §4.1 incomplete-input uses the published version's missing-input function                                           |
| `TESTING.md`                 | §3.1 Support Signal suite; §12 released golden vectors for this version pair                                        |
| `ENVIRONMENT.md`             | §3 `SUAS_SUPPORT_SIGNAL_MODE` = `disabled\|fixture`; fixture is never production authority                          |
| `VERSIONING.md`              | §3 version identities stay separate                                                                                 |

## 2. Change map — file to spec section

| Path                                | Implements                                        |
| ----------------------------------- | ------------------------------------------------- |
| `src/release/pins.ts`               | `RELEASE_MANIFEST-0.2.0.md` runtime pins          |
| `src/signals/sv-001.ts`             | `SIGNAL_SCORING.md` B1–B3, B5                     |
| `src/signals/engine.ts`             | registers `sv-001`; unknown versions still refuse |
| `tests/unit/signal-scoring.test.ts` | `SIGNAL_SCORING.md` B4; `TESTING.md` §12          |

## 3. Design decisions worth review

**The only numbers are the released tables.** Option weights, the imputation
weight `2`, and the ordered rules are copied from `SIGNAL_SCORING.md`. Empty
tables would not have been a close.

**Production compute stays fail-closed.** ENVIRONMENT.md still lists
`disabled|fixture`. TEST/CI remain on `fixture` and
`SUAS_SAFETY_COPY_MODE=placeholder_test_only`. Registering `released: true` does
not enable a production scoring env mode.

**G-I-28 stays open.** `computeSignal` returns a level and basis. Nothing here
opens or updates a Support Case, writes `priority_signal_level`, or defines that
command's idempotency identity.

**`clearSignalEngines` restores `sv-001`.** Tests still register unreleased
fixtures; they cannot leave the released engine unregistered.

**Weights stay in the engine, not a new `answer_options` column.** Slice 9 left
that column out so invented weights could not be stored. The released contract
lives in `src/signals/sv-001.ts`. A later migration can persist `qv-001` rows if
the owner wants a published questionnaire record; this slice does not add one.

## 4. Evidence

| Invariant                                                            | Evidence                                                                 |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Pins declare `0.2.0` and specs commit `4a722e69…`                    | `src/release/pins.ts`; config/build-info/http tests                      |
| `sv-001` is registered `released: true`                              | `tests/unit/signal-scoring.test.ts`; `tests/integration/signals.test.ts` |
| GV-001 through GV-014 match B4                                       | `tests/unit/signal-scoring.test.ts`                                      |
| Missing required safety refuses with `MISSING_REQUIRED_SAFETY_INPUT` | GV-009                                                                   |
| Missing required non-safety imputes weight 2 and records keys        | GV-010, GV-011                                                           |
| Free text, prompts, and labels are absent from basis                 | unit basis test                                                          |
| TEST/CI stay on fixture + placeholder safety copy                    | `.github/workflows/verify.yml`; `tests/setup.ts`                         |
| `production` scoring mode is still rejected                          | `tests/unit/config.test.ts`                                              |

## 5. Environment and configuration changes

`.env.example`, `tests/setup.ts`, `tests/helpers/env.ts`, and
`.github/workflows/verify.yml` re-pin `SUAS_SPEC_VERSION=0.2.0` and
`SUAS_RELEASE_MANIFEST=RELEASE_MANIFEST-0.2.0.md`.
`SUAS_SUPPORT_SIGNAL_MODE` stays `fixture`. `SUAS_SAFETY_COPY_MODE` stays
`placeholder_test_only`.

## 6. Migration notes

None. Schema version is unchanged. No questionnaire rows are inserted.

## 7. Idempotency and failure behavior

Computation identity and settlement are unchanged from Slice 9: the same
Check-In + signal version + questionnaire version settles one primary row.
`sv-001` is deterministic, so a replay of the same canonical answers yields the
same level and a semantically equivalent basis. A new `signal_version` remains a
new identity. Missing required safety throws before a basis exists, so no
Support Signal row can be written from that refusal.

## 8. Security and privacy impact

Basis records version ids, answered option ids, missing/imputed keys, dimension
scores, and one rule id. It does not copy prompts, labels, free text, or other
veteran data. Support Signals remain coordination labels, not diagnosis,
psychometrics, or suicide prediction.

## 9. Availability boundaries preserved

- All twelve readiness gates stay `NOT_READY`.
- `UI_CONFORMANCE` is unchanged.
- SPEC-018 is not authorized.
- G-I-28 is not implemented.
- `/api/v0` and event schema `0.1.0` are unchanged.
- TEST/CI do not switch safety copy to `approved`.

## 10. Semantic gaps returned to `SUAS-specs`

1. **G-I-28 remains open.** `SAFETY.md` §3.2 requires an effective `RED` to open
   or update a Support Case. D-011 does not define the command, idempotency
   identity, non-RED effects, or closed-Case behavior.
2. **ENVIRONMENT.md §3 still lists only `disabled\|fixture`.** A production
   scoring mode is not a released env value even though `sv-001` is released.
3. **`qv-001` is not persisted as a published questionnaire row.** Scoring uses
   the transcribed tables. Publishing that content through the Slice 9 admin
   path is a later implementation choice, not a D-011 requirement.

## 11. Readiness statement

The `CHECK-IN` gate still does not advance. Golden vectors for `qv-001` +
`sv-001` are green as conformance fixtures. Production compute, signal-driven
Case writes, and SPEC-018 evidence remain out of scope. Readiness is recorded in
the specs' `STATUS.md` on accepted evidence, not by this slice.
