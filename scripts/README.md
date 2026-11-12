# scripts

- `generate-icons.mjs` (`npm run icons`): deterministically regenerates the PWA icons in `public/icons/`. It uses only Node built-ins; commit the PNGs it writes.
- `verify-pwa.mjs` (`npm run verify:pwa`, run after `npm run build`): checks that `dist/` keeps the `/tennis-stats/` scope, uses prompt-only updates and caches no provider traffic. CI runs it after the build.
