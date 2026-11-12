import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { APP_BASE, pwaOptions } from './pwa.config';

export default defineConfig({
  base: APP_BASE,
  plugins: [react(), VitePWA(pwaOptions)],
  test: { environment: 'jsdom', setupFiles: './src/test/setup.ts', include: ['src/**/*.test.{ts,tsx}'] },
});
