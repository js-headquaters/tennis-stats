import type { VitePWAOptions } from 'vite-plugin-pwa';

/** GitHub Pages serves the app from this repository subpath; base, SW scope, manifest scope/start_url/id all honour it. */
export const APP_BASE = '/tennis-stats/';

/**
 * Service-worker and manifest configuration (guarded by src/app/pwaConfig.test.ts and `npm run verify:pwa`).
 *
 * Caching policy:
 * - Precache only the built, same-origin application files emitted into dist/ (the glob never reaches other origins).
 * - Navigations inside the scope fall back to the cached index.html so the app opens offline.
 * - There is deliberately NO runtimeCaching: the generated service worker registers no fetch route except the
 *   precache and navigation routes, so every other request (AI provider hosts such as the OpenAI/Anthropic APIs,
 *   any user-configured custom endpoint, POST bodies, Authorization headers and their responses) is never answered
 *   by or stored in the service worker - the browser performs it directly. A custom endpoint is always cross-origin
 *   for this static GitHub Pages deployment, so it cannot match a precache entry either.
 * - `registerType: 'prompt'` with no skipWaiting/clientsClaim: a new version only activates after the user taps
 *   "Reload to update" (src/app/pwaUpdate.ts posts SKIP_WAITING), never by surprise.
 */
export const pwaOptions = {
  base: APP_BASE,
  scope: APP_BASE,
  registerType: 'prompt',
  injectRegister: false, // registration happens in src/main.tsx through virtual:pwa-register
  manifest: {
    id: APP_BASE,
    name: 'Tennis Stats',
    short_name: 'Tennis Stats',
    description: 'Record tennis matches game by game, by voice or by hand, and review your statistics offline.',
    lang: 'en',
    start_url: APP_BASE,
    scope: APP_BASE,
    display: 'standalone',
    orientation: 'portrait',
    theme_color: '#e5f29b', // --lime in src/styles/tokens.css
    background_color: '#f8f9f5', // page background in src/styles/tokens.css
    icons: [
      { src: `${APP_BASE}icons/icon-192.png`, sizes: '192x192', type: 'image/png' },
      { src: `${APP_BASE}icons/icon-512.png`, sizes: '512x512', type: 'image/png' },
      { src: `${APP_BASE}icons/icon-maskable-512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  },
  workbox: {
    globPatterns: ['**/*.{js,css,html,png,svg,ico,woff2}'],
    navigateFallback: 'index.html',
    navigateFallbackAllowlist: [/^\/tennis-stats\//],
    cleanupOutdatedCaches: true,
    skipWaiting: false,
    clientsClaim: false,
    runtimeCaching: [],
  },
} satisfies Partial<VitePWAOptions>;
