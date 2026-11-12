// Post-build guard for the PWA output. Run after `npm run build`: `npm run verify:pwa`.
// Fails (exit 1) if the manifest, service worker or index.html break the /tennis-stats/ scope or caching policy.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = '/tennis-stats/';
const ORIGIN = 'https://pages.example';
const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };
const read = (name) => readFileSync(join(dist, name), 'utf8');

if (!existsSync(join(dist, 'sw.js'))) {
  console.error('verify:pwa: dist/sw.js not found - run `npm run build` first.');
  process.exit(1);
}

// Manifest
const manifest = JSON.parse(read('manifest.webmanifest'));
for (const key of ['id', 'scope', 'start_url']) check(manifest[key] === BASE, `manifest.${key} must be ${BASE}, got ${manifest[key]}`);
check(manifest.display === 'standalone', 'manifest.display must be standalone');
const icons = manifest.icons ?? [];
for (const icon of icons) {
  check(icon.src.startsWith(`${BASE}icons/`), `manifest icon outside ${BASE}icons/: ${icon.src}`);
  check(existsSync(join(dist, icon.src.slice(BASE.length))), `manifest icon file missing from dist: ${icon.src}`);
}
for (const need of ['192x192:any', '512x512:any', '512x512:maskable']) {
  check(icons.some((icon) => `${icon.sizes}:${icon.purpose ?? 'any'}` === need), `manifest needs a ${need} icon`);
}

// Service worker (generated sw.js plus its workbox runtime chunk)
const sw = read('sw.js');
const workboxChunk = readdirSync(dist).find((name) => /^workbox-.*\.js$/.test(name));
const swAll = sw + (workboxChunk ? read(workboxChunk) : '');
const precache = sw.match(/precacheAndRoute\((\[.*?\])\s*,/s);
check(precache, 'sw.js has no precacheAndRoute manifest');
if (precache) {
  const urls = [...precache[1].matchAll(/url:"([^"]+)"/g)].map((match) => match[1]);
  check(urls.includes('index.html'), 'index.html must be precached');
  for (const url of urls) {
    const resolved = new URL(url, `${ORIGIN}${BASE}sw.js`);
    check(resolved.origin === ORIGIN && resolved.pathname.startsWith(BASE), `precache entry escapes ${BASE}: ${url}`);
    check(!/\.json$/i.test(url), `precache must not include JSON data files: ${url}`);
  }
}
check(/createHandlerBoundToURL\("index.html"\)/.test(sw), 'navigation fallback must be index.html (resolves to /tennis-stats/index.html)');
check(/allowlist:\[\/\^\\\/tennis-stats\\\/\/\]/.test(sw), 'navigation fallback must be allow-listed to /tennis-stats/');
const routeCount = (sw.match(/registerRoute\(/g) ?? []).length;
check(routeCount === 1, `sw.js must register only the navigation route (no runtime caching), found ${routeCount}`);
for (const strategy of ['CacheFirst', 'StaleWhileRevalidate', 'NetworkFirst', 'ExpirationPlugin']) {
  check(!sw.includes(strategy), `sw.js must not use runtime strategy ${strategy}`);
}
for (const host of ['openai', 'anthropic']) check(!swAll.toLowerCase().includes(host), `service worker mentions provider host "${host}"`);
check(!/clientsClaim\(\)/.test(sw), 'sw.js must not call clientsClaim()');
const skipWaitingCalls = sw.match(/skipWaiting\(\)/g) ?? [];
check(skipWaitingCalls.length === 1 && /"SKIP_WAITING"===\w+\.data\.type&&self\.skipWaiting\(\)/.test(sw), 'skipWaiting() may only run in response to the SKIP_WAITING message');

// index.html
const html = read('index.html');
for (const [, url] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
  check(url.startsWith(BASE), `index.html URL outside ${BASE}: ${url}`);
}
check(html.includes(`<link rel="manifest" href="${BASE}manifest.webmanifest">`), 'index.html must link the manifest under the base');
check(html.includes('apple-touch-icon'), 'index.html must declare an apple-touch-icon');
check(!html.includes('registerSW.js'), 'registration must come from src/main.tsx, not an injected registerSW.js');

if (failures.length) {
  console.error(`verify:pwa failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(`verify:pwa ok: manifest, sw.js (${workboxChunk}) and index.html honour ${BASE} and cache no provider traffic.`);
