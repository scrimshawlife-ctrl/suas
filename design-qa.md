# SUAS web → iOS operator visual alignment QA

**Comparison target**

- Source visual truth: `https://scrimshawlife-ctrl.github.io/suas/ios-operator.html` and its checked-in stylesheet, `docs/ios-operator.css`.
- Implementation: synthetic Veteran home rendered from `renderVeteranHome` at `http://terminal.local:4173/`.
- Viewport: 1348 × 926 CSS px for both live browser captures.
- State: source operator demo at `DEMO_READY`; implementation Veteran home with a synthetic QRF in `MATCHING`, approved crisis copy, and Home navigation selected.
- Comparison scope: the released web runtime keeps its own information architecture and truthful states. The QA target is the mobile-app visual system: palette, typography, surface hierarchy, radii, controls, category accents, and responsive treatment.

**Reference-to-implementation mapping**

| Reference token or treatment                                | Web implementation                                                   |
| ----------------------------------------------------------- | -------------------------------------------------------------------- |
| Service blue `#1c529e` and dark blue `#12325f`              | Primary actions, focus hierarchy, headings, and SUAS wordmark        |
| Grouped surface `#f2f4f7` and card `#ffffff`                | Page background, forms, state panels, resource cards, and navigation |
| Ink `#101828` and muted `#667085`                           | Primary and secondary text                                           |
| Transportation `#2173b8`, food `#cc731a`, shelter `#40804d` | Operational resource-card category accents                           |
| 10–16 px iOS radii                                          | Wordmark tile, fields, actions, state panels, and cards              |
| Apple system display stack                                  | All runtime typography with SF Pro-compatible fallbacks              |
| 48 px primary controls                                      | Actions, inputs, and check-in controls                               |
| Soft blue radial page wash                                  | Browser background, matching the operator-demo canvas                |

**Findings**

- No actionable P0, P1, or P2 visual differences remain within the requested design-system scope.
- The source page's three-column marketing/demo composition is intentionally not copied into the authenticated runtime. Doing so would replace the product's released task flow rather than style it.
- Existing safety copy, availability labels, QRF state language, routes, and accessibility behavior remain intact.

**Visual and computed-style evidence**

- The source and implementation were opened side by side in the same browser session and viewport.
- The implementation visibly matches the reference's light blue/white palette, navy hierarchy, rounded card geometry, blue primary actions, and compact SUAS tile wordmark.
- Computed implementation values confirmed white 16 px resource cards and distinct shelter, food, and transportation accents.
- The implementation uses the exact canonical values exported from `docs/ios-operator.css`, with unit coverage preventing token drift.
- No new image assets were introduced.

**Automated verification**

- Focused UI tests: 110 passed.
- Typecheck: passed.
- ESLint: passed.
- Production build: passed.
- Prettier and diff whitespace checks: passed.

**Implementation checklist**

- [x] Use `ios-operator.html` as the visual source of truth.
- [x] Map its exact palette into the shared web theme.
- [x] Match iOS surfaces, radii, typography, action hierarchy, and category colors.
- [x] Update the web wordmark to the reference's SUAS tile treatment.
- [x] Preserve released behavior, safety language, and accessibility floors.
- [x] Verify the running implementation against the live reference at the same viewport.

final result: passed
