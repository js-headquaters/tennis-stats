# Tennis Stats

A mobile-first progressive web app for recording tennis matches by voice or by hand and reviewing your statistics. Speak a game description, let an AI provider turn it into games, review and correct the draft, then browse match history and a statistics dashboard. Manual entry, editing, history and dashboards work offline.

Live app: <https://js-headquaters.github.io/tennis-stats/>

Primary targets are current iPhone Safari and Chrome on iOS (both WebKit). Current desktop browsers are secondary targets.

## Data and API keys

- All data is stored locally in your browser (IndexedDB). There is no server and no account.
- AI provider API keys you enter in Settings are stored in browser local storage. This is less secure than a backend proxy, and provider guidance advises against browser-held keys. Use restricted, expiring keys with hard spend limits.
- Keys are excluded from backups and are never committed, logged or cached by the service worker.
- Browser data can be erased or lost when you change device or browser. Back up regularly: **Settings -> Data -> Export backup**, and keep the file somewhere safe. Restore with Import backup.

## Voice diagnostics

To help debug voice parsing, each transcription or parsing call to an AI provider is recorded locally next to the match: the transcript, the raw provider response, timestamps, provider and model, and any error. Audio and API keys are never stored (keys are redacted from provider bodies).

- Diagnostics are kept with the match until the match is deleted.
- They are excluded from backup files.
- They are capped at 500 rows per match and 256 KB per text field.
- To get them, open **Match Details** and choose **Download voice diagnostics**.

## Local setup

Requires Node 22 and npm.

```sh
npm ci
npm run dev
```

The dev server serves the app under `/tennis-stats/` (the GitHub Pages subpath).

For the browser tests, install Playwright browsers once:

```sh
npx playwright install --with-deps chromium webkit
```

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Start the Vite dev server. |
| `npm run build` | Type-check (`tsc -b`) and produce the production build in `dist/`. |
| `npm run preview` | Serve the production build locally. |
| `npm run typecheck` | Type-check without emitting. |
| `npm run lint` | Run ESLint. |
| `npm test` | Run unit and integration tests (Vitest). |
| `npm run test:e2e` | Run Playwright tests (Chromium and WebKit) against a production build served at `/tennis-stats/`. Add `-- --grep @smoke` for the smoke subset. |
| `npm run verify:pwa` | Assert the built manifest, service worker and `index.html` honour the `/tennis-stats/` scope. Run after `npm run build`. |
| `npm run icons` | Regenerate the PWA icons. |

Full local release gate:

```sh
npm ci && npm run typecheck && npm run lint && npm test && npm run build && npm run verify:pwa \
  && npm run test:e2e -- --grep @smoke --project=chromium --project=webkit
```

## CI and deployment

`develop` is the primary development and deployment branch.

1. **CI** (`.github/workflows/ci.yml`) runs on pull requests and on pushes to `develop`. One job runs type check, lint, unit/integration tests, production build, `verify:pwa` and the Playwright smoke tests; a second job runs the full Playwright suite. Playwright reports and traces are uploaded only on failure.
2. **Deploy** (`.github/workflows/pages.yml`) runs only after a CI run for a push to `develop` finishes successfully (or by manual dispatch from `develop`). It rebuilds the exact commit CI verified, re-runs `verify:pwa`, and publishes `dist/` to GitHub Pages. Pull requests never deploy.

First-time repository setup (all required for deployment to work):

1. Push `develop` first to the empty remote so it becomes the repository's **default branch** (do not create `main` first). GitHub runs `workflow_run` workflows from the default branch's copy of `pages.yml`; if the default branch is anything else, Pages silently never deploys.
2. **Settings -> Pages**: set **Source** to **GitHub Actions**.
3. **Settings -> Environments -> github-pages**: make sure the deployment branch rule allows `develop` (needed for both automatic and manual deploys).
4. Optionally protect `develop` and require the CI jobs to pass.

Manual dispatch of the Deploy workflow publishes the current `develop` head **without the CI gate** (it only builds and runs `verify:pwa`), so use it deliberately.

## Real-device testing

Automated tests cannot reproduce iOS microphone prompts, Home Screen installation or service-worker update timing. Follow [docs/ios-smoke-test.md](docs/ios-smoke-test.md) on a real iPhone before releases that touch recording, storage, the service worker or the manifest.

## Accepted risks

- `npm audit` reports findings in build-time dependencies (the Workbox toolchain used by the PWA plugin). They are not shipped in the runtime bundle, and CI deliberately does not gate on `npm audit`. Review them when upgrading dependencies.
- Browser-held API keys (see above) are an explicit, documented trade-off.
