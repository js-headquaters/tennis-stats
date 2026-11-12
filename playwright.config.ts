import { defineConfig, devices } from '@playwright/test';

/**
 * E2E runs against the PRODUCTION build (`vite build` + `vite preview`) served under the GitHub Pages base.
 * - Smoke subset: tests whose title contains `@smoke` (`npm run test:e2e -- --grep @smoke`); one core happy path per spec.
 * - Service workers are blocked by default so a stale precache can never affect determinism; offline/PWA tests opt in
 *   per test with `test.use({ serviceWorkers: 'allow' })`.
 * - AI providers are never reached: specs mock them with `mockAi` from tests/e2e/fixtures.ts.
 */
export const PREVIEW_PORT = 4174;
const ORIGIN = `http://127.0.0.1:${PREVIEW_PORT}`;
const BASE_URL = `${ORIGIN}/tennis-stats/`;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: BASE_URL,
    serviceWorkers: 'block',
    timezoneId: 'UTC',
    locale: 'en-US',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Pixel 7'], serviceWorkers: 'block' } },
    { name: 'webkit', use: { ...devices['iPhone 15'], serviceWorkers: 'block' } },
  ],
  webServer: {
    command: `npm run build && npm run preview -- --host 127.0.0.1 --port ${PREVIEW_PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
