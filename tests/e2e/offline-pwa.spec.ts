import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Page } from '@playwright/test';
import {
  FAKE_API_KEY, FIXED_NOW, buildOpponent, buildSnapshot, configureAi, expect, installFakeMicrophone, mockAi, readDatabase,
  seedDatabase, test as base,
} from './fixtures';

// Installability signals, offline resume of the app shell / an active match / a pending voice draft (journeys 10, 14),
// the explicit-reload update flow with a REAL service-worker update, and proof that AI traffic is never cached.
// Service workers are blocked suite-wide (playwright.config.ts); every test here opts in.
//
// The tests run through a small same-machine HTTP proxy in front of the production `vite preview` server. It serves the
// build unchanged until `publishUpdate()`, after which /tennis-stats/sw.js gains one trailing comment line: a byte-different
// service worker script, exactly what the browser's update check looks for when a new release is deployed. Playwright's
// own routing cannot do this: it does not see the browser's service-worker update fetches. Each test gets its own proxy
// port, i.e. a fresh origin, so no service worker or cache leaks between tests.

const UPSTREAM = { host: '127.0.0.1', port: 4174 };
interface Proxy { origin: string; baseURL: string; publishUpdate(): void; swRequests: number }

const test = base.extend<{ releaseServer: Proxy }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright fixtures must destructure their (here: no) dependencies
  releaseServer: async ({}, use) => {
    let revision = 0;
    const state = { swRequests: 0 };
    const server = http.createServer((req, res) => {
      const isWorker = req.url?.split('?')[0] === '/tennis-stats/sw.js';
      const headers = { ...req.headers, host: `${UPSTREAM.host}:${UPSTREAM.port}` };
      if (isWorker) { state.swRequests++; delete headers['if-none-match']; delete headers['if-modified-since']; delete headers['accept-encoding']; }
      const upstream = http.request({ ...UPSTREAM, path: req.url, method: req.method, headers }, response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(chunk as Buffer));
        response.on('end', () => {
          let body = Buffer.concat(chunks);
          const out = { ...response.headers };
          if (isWorker && revision > 0) { body = Buffer.concat([body, Buffer.from(`\n// e2e release ${revision}\n`)]); out['cache-control'] = 'no-cache'; }
          out['content-length'] = String(body.length); delete out['transfer-encoding'];
          res.writeHead(response.statusCode ?? 502, out); res.end(body);
        });
      });
      upstream.on('error', () => { res.writeHead(502); res.end(); });
      req.pipe(upstream);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      await use({ origin, baseURL: `${origin}/tennis-stats/`, publishUpdate: () => { revision++; }, get swRequests() { return state.swRequests; } });
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  },
  baseURL: async ({ releaseServer }, use) => { await use(releaseServer.baseURL); },
});

test.use({ serviceWorkers: 'allow' });

/** Waits until the service worker is activated AND controls this page (after first install a reload is needed: no clientsClaim). */
async function controlledByServiceWorker(page: Page) {
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.active?.state), { message: 'service worker activated' }).toBe('activated');
  if (!await page.evaluate(() => !!navigator.serviceWorker.controller)) await page.reload();
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null)).toMatch(/\/tennis-stats\/sw\.js$/);
}
async function cacheEntries(page: Page) {
  return page.evaluate(async () => {
    const out: Array<{ cache: string; url: string; requestHeaders: Array<[string, string]>; responseHeaders: Array<[string, string]>; type: string; body: string | null }> = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        const response = await cache.match(request);
        const type = response?.headers.get('content-type') ?? '';
        out.push({ cache: name, url: request.url, requestHeaders: [...request.headers.entries()], responseHeaders: response ? [...response.headers.entries()] : [], type, body: response && !type.startsWith('image/') ? await response.clone().text() : null });
      }
    }
    return out;
  });
}
const banner = (page: Page) => page.locator('.connectivity-banner');
const status = (page: Page, text: string) => page.locator('[role="status"]', { hasText: text });
const marker = (page: Page) => page.evaluate(() => (window as unknown as { __e2eDocument?: string }).__e2eDocument ?? null);
const markDocument = (page: Page) => page.evaluate(() => { (window as unknown as { __e2eDocument: string }).__e2eDocument = 'original'; });

test('@smoke the production build is installable under /tennis-stats/: manifest, icons and a scoped service worker', async ({ page, releaseServer: proxy, browserName }) => {
  await page.goto('#/');
  // The page links the manifest and an iOS home-screen icon under the base.
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/tennis-stats/manifest.webmanifest');
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href', '/tennis-stats/icons/apple-touch-icon-180.png');
  await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute('content', 'yes');

  const manifestResponse = await page.request.get(`${proxy.origin}/tennis-stats/manifest.webmanifest`);
  expect(manifestResponse.status()).toBe(200);
  const manifest = await manifestResponse.json() as { id: string; scope: string; start_url: string; display: string; name: string; icons: Array<{ src: string; sizes: string; type: string; purpose?: string }> };
  expect(manifest).toMatchObject({ id: '/tennis-stats/', scope: '/tennis-stats/', start_url: '/tennis-stats/', display: 'standalone', name: 'Tennis Stats' });
  expect(manifest.icons.map(icon => icon.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']));
  expect(manifest.icons.some(icon => icon.purpose === 'maskable')).toBe(true);
  for (const icon of [...manifest.icons, { src: '/tennis-stats/icons/apple-touch-icon-180.png', sizes: '180x180', type: 'image/png' }]) {
    expect(icon.src.startsWith('/tennis-stats/'), icon.src).toBe(true);
    const response = await page.request.get(`${proxy.origin}${icon.src}`);
    expect(response.status(), icon.src).toBe(200);
    expect(response.headers()['content-type'], icon.src).toBe('image/png');
    const png = await response.body();
    // PNG signature, then the IHDR width/height must match the declared size.
    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
    expect(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`, icon.src).toBe(icon.sizes);
  }

  // The service worker registers with the GitHub Pages scope, precaches the shell, and then controls the app.
  await controlledByServiceWorker(page);
  const registration = await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); return { scope: r?.scope, script: r?.active?.scriptURL }; });
  expect(registration).toEqual({ scope: `${proxy.origin}/tennis-stats/`, script: `${proxy.origin}/tennis-stats/sw.js` });
  const cached = (await cacheEntries(page)).map(entry => new URL(entry.url).pathname);
  expect(cached).toEqual(expect.arrayContaining(['/tennis-stats/index.html', '/tennis-stats/manifest.webmanifest', '/tennis-stats/icons/icon-192.png']));
  // Chromium exposes no reliable install signal to automation (beforeinstallprompt depends on engagement heuristics) and
  // WebKit/iOS has no install event at all (Add to Home Screen is manual): manifest + icons + scoped, controlling
  // worker are the representative signals; the real-device check is docs/ios-smoke-test.md.
  test.info().annotations.push({ type: 'installability', description: `${browserName}: manifest, icons, scoped controlling service worker asserted; no install-prompt event is asserted` });
});

test.describe('offline resume', () => {
  test.use({ persistentStorage: true }); // the voice recording is a Blob (WebKit ephemeral contexts reject Blobs in IndexedDB)

  test('offline: the cached shell opens every route, a match is started and scored by hand, a voice draft waits and is retried once online', async ({ page, context, browserName }) => {
    await page.clock.setFixedTime(new Date(FIXED_NOW));
    await configureAi(page);
    await installFakeMicrophone(page);
    const ai = await mockAi(page, { games: 2 });
    await seedDatabase(page, buildSnapshot({ opponents: [buildOpponent('Alex Example')] }), { then: '#/' });
    await controlledByServiceWorker(page);

    await context.setOffline(true);
    for (const route of ['#/', '#/matches', '#/settings', '#/matches/new']) {
      await page.goto(route);
      await expect(banner(page), `${route} offline banner`).toContainText("You're offline. Manual entry, editing, history and dashboards still work.");
    }
    await page.reload(); // a reload of the current route also comes from the cache
    await expect(page.getByRole('heading', { name: 'New match' })).toBeVisible();

    // Start a match offline and enter a game manually.
    await page.getByLabel('Opponent', { exact: true }).fill('Alex Example');
    await page.getByLabel('Format').selectOption({ label: 'One set' });
    await page.getByLabel('Player serves first').check();
    await page.getByRole('button', { name: 'Start match' }).click();
    await expect(page).toHaveURL(/#\/matches\/[^/]+\/live$/);
    const matchId = decodeURIComponent(/#\/matches\/([^/]+)\/live$/.exec(page.url())![1]);
    await page.getByRole('button', { name: 'Manual game entry' }).click();
    const form = page.getByRole('form', { name: 'Manual game entry' });
    await form.getByLabel('Result').selectOption({ label: 'Won' });
    await form.getByLabel('Net errors').fill('0');
    await form.getByRole('button', { name: 'Add game' }).click();
    await expect(page.getByText('Set 1: 1–0 (active)')).toBeVisible();

    // Reload offline: the shell comes from the cache and the game from IndexedDB.
    await page.reload();
    await expect(page.getByText('Set 1: 1–0 (active)')).toBeVisible();
    await expect(banner(page)).toContainText("You're offline.");
    let stored = await readDatabase(page);
    expect(stored.matches).toEqual([expect.objectContaining({ id: matchId, status: 'active' })]);
    expect(stored.games).toEqual([expect.objectContaining({ ordinal: 1, result: 'won', netErrors: 0, wideErrors: null })]);

    // A voice recording made offline is kept, waiting to retry, without contacting a provider; it survives a reload.
    await page.goto(`#/matches/${matchId}/record`);
    await page.getByRole('button', { name: 'Start recording' }).click();
    await page.getByRole('button', { name: 'Stop recording' }).click();
    await expect(page).toHaveURL(/#\/voice\/[^/]+$/);
    await expect(status(page, 'Waiting to retry.')).toBeVisible();
    await expect(page.getByText('Waiting for an internet connection.')).toBeVisible();
    await page.reload();
    await expect(status(page, 'Waiting to retry.')).toBeVisible();
    stored = await readDatabase(page);
    expect(stored.voiceDrafts).toMatchObject([{ matchId, state: 'waiting-retry', error: { code: 'offline' }, recording: { size: 416, type: 'audio/mp4' } }]);
    expect(ai.calls).toEqual([]);

    // Back online: the banner says so, the retry reaches the (mocked) providers once, and confirming adds exactly 2 games.
    await context.setOffline(false);
    await expect(banner(page)).toContainText('Back online. Voice drafts that were waiting can be retried now.');
    if (browserName === 'webkit') {
      // Playwright WebKit cannot intercept requests made by a service-worker-controlled page (page.route and context.route
      // both miss them and they reach the real host), so the mocked retry runs uncontrolled there. See the report.
      await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())?.unregister(); });
      await page.reload();
      await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller)).toBeNull();
      await expect(status(page, 'Waiting to retry.')).toBeVisible();
    }
    await page.getByRole('button', { name: 'Retry processing' }).click();
    await expect(status(page, 'Ready for review.')).toBeVisible();
    expect(ai.calls.map(call => call.kind)).toEqual(['transcription', 'openai-parser']);
    await page.getByRole('button', { name: 'Confirm and add' }).click();
    await expect(page).toHaveURL(new RegExp(`#/matches/${matchId}/live$`));
    stored = await readDatabase(page);
    expect(stored.games.map(game => game.ordinal).sort()).toEqual([1, 2, 3]);
    expect(stored.voiceDrafts).toEqual([]);
  });
});

test.describe('update flow with a real service-worker update', () => {
  test.use({ persistentStorage: true });

  test('the update prompt never reloads by itself, is blocked while recording, and applies only on "Reload to update"', async ({ page, context, releaseServer: proxy }) => {
    await page.clock.setFixedTime(new Date(FIXED_NOW));
    await configureAi(page);
    await installFakeMicrophone(page);
    const ai = await mockAi(page);
    await seedDatabase(page, buildSnapshot({ opponents: [buildOpponent('Alex Example')] }), { then: '#/matches/new' });
    await controlledByServiceWorker(page);
    await page.getByLabel('Opponent', { exact: true }).fill('Alex Example');
    await page.getByRole('button', { name: 'Start match' }).click();
    await expect(page).toHaveURL(/#\/matches\/[^/]+\/live$/);
    const matchId = decodeURIComponent(/#\/matches\/([^/]+)\/live$/.exec(page.url())![1]);
    await page.goto(`#/matches/${matchId}/record`);
    const original = await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL);
    await markDocument(page);

    // A recording is in progress when a new release is deployed and the browser's update check finds it.
    await page.getByRole('button', { name: 'Start recording' }).click();
    await expect(page.getByRole('button', { name: 'Stop recording' })).toBeVisible();
    proxy.publishUpdate();
    await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())?.update(); });
    const prompt = page.getByRole('region', { name: 'App update' });
    await expect(prompt).toContainText('An update is available. Reload to start using the new version.');
    await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.waiting?.state ?? null), { message: 'the new worker waits' }).toBe('installed');
    const reload = prompt.getByRole('button', { name: 'Reload to update' });
    await expect(reload).toBeDisabled();
    await expect(prompt).toContainText('Finish or save your recording or draft first. Reloading now would lose it.');
    await reload.click({ force: true }); // even a forced tap on the disabled button does nothing
    expect(await marker(page), 'no reload while recording').toBe('original');

    // Offline from here on: stopping saves the recording as a draft that waits for a connection (no provider involved).
    await context.setOffline(true);
    await page.getByRole('button', { name: 'Stop recording' }).click();
    await expect(page).toHaveURL(/#\/voice\/[^/]+$/);
    await expect(status(page, 'Waiting to retry.')).toBeVisible();
    // The draft is safely stored, so the reload is offered — and still not taken automatically.
    await expect(reload).toBeEnabled();
    await expect(prompt).not.toContainText('Finish or save');
    expect(await marker(page), 'still no automatic reload').toBe('original');
    expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.waiting?.state ?? null), 'the new worker is still only waiting').toBe('installed');
    const draftUrl = page.url();

    await Promise.all([page.waitForEvent('load'), reload.click()]);
    await expect.poll(() => marker(page), { message: 'the page reloaded' }).toBeNull();
    await expect(page).toHaveURL(draftUrl);
    await expect(status(page, 'Waiting to retry.')).toBeVisible();
    await expect(prompt).toHaveCount(0);
    // The waiting worker is gone and the page is controlled again. WebKit (offline here) can keep reporting the new
    // worker as 'activating' for several seconds after it took control, so both states are accepted.
    await expect.poll(() => page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); return { waiting: r?.waiting ?? null, controller: navigator.serviceWorker.controller?.scriptURL }; }), { message: 'the new worker took over' })
      .toEqual({ waiting: null, controller: original });
    expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.active?.state)).toMatch(/^activat(ing|ed)$/);
    const stored = await readDatabase(page);
    expect(stored.voiceDrafts).toMatchObject([{ matchId, state: 'waiting-retry', recording: { size: 416, type: 'audio/mp4' } }]);
    expect(proxy.swRequests, 'the browser fetched the changed worker script').toBeGreaterThanOrEqual(2);
    expect(ai.calls).toEqual([]);
  });
});

test('the service worker never answers or stores AI traffic', async ({ page, releaseServer: proxy, browserName }) => {
  test.skip(browserName === 'webkit', 'Playwright WebKit cannot intercept requests from a service-worker-controlled page: the AI call would reach the real provider host instead of the mock');
  await configureAi(page);
  const ai = await mockAi(page, { games: 1 });
  await page.goto('#/');
  await controlledByServiceWorker(page);
  const precached = (await cacheEntries(page)).map(entry => entry.url).sort();

  await page.goto('#/settings');
  const parser = page.locator('fieldset', { has: page.locator('legend', { hasText: 'Statistics parser' }) });
  const transcription = page.locator('fieldset', { has: page.locator('legend', { hasText: 'Transcription' }) });
  for (let attempt = 1; attempt <= 3; attempt++) {
    await parser.getByRole('button', { name: 'Test connection' }).click();
    await expect(parser.getByRole('status')).toHaveText('Connection successful.');
    // Every attempt reached the network handler: nothing was replayed from a cache.
    expect(ai.callsOf('openai-parser'), `parser attempt ${attempt}`).toHaveLength(attempt);
    await parser.getByLabel('Model').fill(`gpt-4o-mini`); // clears the status line for the next attempt
  }
  await transcription.getByRole('button', { name: 'Test connection' }).click();
  await expect(transcription.getByRole('status')).toHaveText('Connection successful.');
  expect(ai.callsOf('transcription')).toHaveLength(1);
  expect(ai.calls.every(call => call.headers.authorization === `Bearer ${FAKE_API_KEY}`), 'the requests did carry the key').toBe(true);

  // Cache Storage holds exactly the precache: same-origin app files, no provider host, no credential anywhere.
  const entries = await cacheEntries(page);
  expect(entries.map(entry => entry.url).sort(), 'no runtime caching happened').toEqual(precached);
  expect(new Set(entries.map(entry => entry.cache))).toEqual(new Set([`workbox-precache-v2-${proxy.origin}/tennis-stats/`]));
  for (const entry of entries) {
    expect(entry.url.startsWith(`${proxy.origin}/tennis-stats/`), entry.url).toBe(true);
    expect(entry.url).not.toMatch(/openai|anthropic/);
    expect(entry.requestHeaders.map(([name]) => name), entry.url).not.toContain('authorization');
    expect(JSON.stringify(entry.requestHeaders) + JSON.stringify(entry.responseHeaders), entry.url).not.toContain(FAKE_API_KEY);
    if (entry.body !== null) expect(entry.body, entry.url).not.toContain(FAKE_API_KEY);
  }
});
