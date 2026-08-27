# LOCAL UI / a11y baseline — 2026-08-26

**Environment:** `SUAS_ENV=LOCAL` Worker soak  
**Host:** `https://suas.zer0state-noema.workers.dev`  
**Data:** Neon synthetic seed (`npm run seed`); bearers from `.local-secrets/seed-summary.json`  
**Claim boundary:** This is a **pinned LOCAL baseline**, not a `UI_CONFORMANCE=READY` claim.
Formal synthetic STAGING now has automated 320px reflow and keyboard-entry coverage in
`tests/e2e/staging.spec.ts`; gate closure still needs human full-workflow focus-order and
screen-reader review.

## Surfaces captured (HTTP 200)

| Id | Path | Audience |
| --- | --- | --- |
| landing | `/app` | public |
| veteran-home | `/app/home` | veteran |
| notifications | `/app/notifications` | recipient |
| preferences | `/app/notifications/preferences` | recipient |
| consents | `/app/consents` | veteran |
| trusted-contacts | `/app/trusted-contacts` | veteran |
| resources | `/app/resources` | veteran |
| resources-food | `/app/resources/food` | veteran |
| immediate-resources | `/app/immediate-resources` | veteran |
| responder | `/app/responder` | responder |
| responder-case | `/app/responder/cases/:id` | responder |
| responder-availability | `/app/responder/availability` | responder |

Raw HTML: `html/*.html` · fetch metadata: `fetch-summary.json`.

## Markup a11y (`src/ui/a11y.ts`)

Ran `auditAccessibility(..., 'DOCUMENT')` on every captured document.

**Result: 12 / 12 PASS** (0 findings). See `markup-a11y.json`.

This covers only markup-decidable WCAG 2.2 AA checks (lang, viewport zoom, headings, labels, etc.). It does **not** prove full AA.

## Lighthouse (Chrome DevTools snapshot)

| Surface | Device | Accessibility | Notes |
| --- | --- | --- | --- |
| veteran-home | mobile | **100** | SEO fails are expected on `file://` / app HTML (meta description, robots.txt, llms.txt) — not product blockers |
| responder | mobile | **100** | Same |

Reports: `lighthouse-veteran-home-mobile.json`, `lighthouse-responder-mobile.json`.

## Screenshots

Under `screenshots/` (pinned visual baseline for human review):

- `veteran-home-mobile.png`
- `responder-desktop.png` / `responder-mobile.png`
- `responder-case-desktop.png`
- `resources-food-desktop.png`
- `consents-desktop.png`

## Still required for UI_CONFORMANCE READY

1. Human review of full workflow focus order and screen-reader behavior on the pinned surfaces.
2. Re-pin screenshots from live **STAGING** CSS if the visual baseline is used for final sign-off.
3. Optional: SAFETY `approved` copy mode checklist (separate from this baseline).

## How to reproduce

```bash
# .env → Neon unpooled; SUAS_ENV=LOCAL
npm run seed   # refresh bearers if expired
# then re-fetch surfaces with Authorization: Bearer <credential>
# audit: npx tsx .local-secrets/run-a11y-audit.mts  (or equivalent)
```
