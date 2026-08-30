# SUAS web → native iOS visual alignment QA

**Comparison target**

- Source visual truth: `scrimshawlife-ctrl/suas-ios` SwiftUI implementation (`ContentView.swift`, `LoginView.swift`, `HomeView.swift`, and `StatusView.swift`). Exact token values and component rules were available, but no rendered iOS screenshot, simulator, or Figma frame was available to open.
- Implementation screenshot: `/workspace/scratch/suas-ios-style-web-preview-2026-08-30.jpg`.
- Browser URL: `http://terminal.local:4173/app/home`.
- Viewport and implementation pixels: 1348 × 926 CSS px at density 1; JPEG is 1348 × 926 px.
- State: synthetic Veteran home, approved crisis-copy mode, Home navigation selected.
- Density normalization: none required for the implementation capture. Source normalization is `NOT_COMPUTABLE` because no rendered source image was available.

**Findings**

- [BLOCKER] Source visual comparison unavailable
  - Location: full-view and focused-region comparison.
  - Evidence: the iOS source code exposes exact colors, system typography, radii, grouped surfaces, and component structure, but there is no rendered iOS reference image to place beside the browser capture.
  - Impact: token and structural alignment are verified, but pixel-level differences in spacing, SwiftUI optical sizing, and device-specific rendering cannot be judged truthfully.
  - Fix: capture `HomeView` and `LoginView` from the iOS simulator at a named device/scale, then rerun side-by-side visual QA against the corresponding web state.

**Verified implementation evidence**

- Fonts and typography: Apple system-family fallbacks are first; large headings use the display stack and UI text uses the text stack.
- Spacing and layout rhythm: one full-width service card per row, 12–16 px radii, grouped background, white elevated cards, 48 px primary targets, and safe-area-aware fixed navigation.
- Colors and visual tokens: service blue `#1c529e`; transportation `#2173b8`; food `#cc731a`; shelter `#40804d`; grouped background `#f2f2f7`; primary text `#1c1c1e`; secondary text `#636366`.
- Image quality and assets: no new image assets were required. The existing Zero State mark remains unchanged.
- Copy and content: existing released web copy and truthful availability states are preserved; no domain behavior or support claims were added.
- Focused region evidence: computed browser styles confirmed 16 px card radii, white card surfaces, and the correct green/amber/blue left accents for Shelter/Food/Transportation.
- Primary interaction tested: fixed Home navigation loaded `/app/home` and retained the Support view.
- Console check: no warning or error originated from `http://terminal.local`; an unrelated browser-extension metadata error was excluded.
- Automated checks: 139 focused unit tests passed; typecheck, lint, build, formatting, and diff whitespace checks passed.

**Comparison history**

- Initial implementation capture showed approved crisis copy as an uncontained text block and allowed multi-column service cards.
- Fixes applied: added the iOS-style danger-tinted crisis card and locked service cards to one full-width row each.
- Post-fix evidence: browser capture shows the contained crisis surface; focused computed-style evidence confirms the service-card palette and radii.

**Open Questions**

- Pixel fidelity to the native simulator remains `NOT_COMPUTABLE` until a rendered iOS source capture exists.

**Implementation Checklist**

- [x] Map canonical iOS tokens into the web theme.
- [x] Match grouped surfaces, radii, typography, action hierarchy, and category colors.
- [x] Preserve released routes, copy, availability states, and accessibility floors.
- [x] Verify the rendered browser implementation and primary navigation.
- [ ] Capture native iOS reference screens and complete side-by-side comparison.

**Follow-up Polish**

- Recheck optical font weights and section spacing against an iPhone simulator capture.

final result: blocked
