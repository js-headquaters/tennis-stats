# Compact Icon Actions Design

## Intent

Make the mobile interface faster to scan by adding consistent Lucide icons and replacing unnecessarily long visible button/link copy with short action labels.

## Goals

- Add `lucide-react` as the single icon source.
- Add icons to the persistent Home/Matches/Settings navigation and frequent actions across dashboard, match, voice, settings, recovery, and update UI.
- Keep visible action labels to one or two words where practical, such as `New match`, `Record`, `Manual entry`, `Retry`, `Save`, `Export`, and `Update`.
- Preserve the full meaning in `aria-label` when visible copy is shortened; icons are decorative and hidden from assistive technology.
- Preserve 44px touch targets and existing disabled/loading behavior.

## Non-goals

- Do not replace every label with an icon-only control.
- Do not shorten warnings, explanatory text, form labels, headings, or status messages.
- Do not weaken destructive confirmations: actions such as clearing data, abandoning a match, or discarding a draft remain explicit in context.
- Do not redesign colors, spacing, or page layouts beyond the minimum icon alignment styles.

## Approach

Use `lucide-react` and a small shared `IconLabel` component that renders a decorative icon beside visible text. Apply it to persistent navigation and high-frequency or currently long actions. When visible text loses context (for example, `Edit game 3` becoming `Edit`), retain the original full accessible name with `aria-label="Edit game 3"`.

Alternatives considered: a local SVG set avoids a dependency but duplicates icon maintenance; Unicode symbols are inconsistent across iOS fonts. The user selected Lucide React.

## Verification

- Component tests check icon rendering, short visible copy, and unchanged accessible names.
- Existing touch-target tests must continue to pass.
- Full unit, typecheck, lint, build, PWA, and Chromium/WebKit Playwright gates remain required.
