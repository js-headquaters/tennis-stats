// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { APP_BASE, pwaOptions } from '../../pwa.config';

const PROVIDER_HOSTS = ['api.openai.com', 'api.anthropic.com', 'openai', 'anthropic'];

describe('PWA config invariants', () => {
  it('is scoped to the GitHub Pages subpath', () => {
    expect(APP_BASE).toBe('/tennis-stats/');
    expect(pwaOptions.base).toBe(APP_BASE);
    expect(pwaOptions.scope).toBe(APP_BASE);
    const manifest = pwaOptions.manifest;
    if (!manifest) throw new Error('manifest missing');
    expect(manifest.scope).toBe(APP_BASE);
    expect(manifest.start_url).toBe(APP_BASE);
    expect(manifest.id).toBe(APP_BASE);
    expect(manifest.display).toBe('standalone');
    for (const icon of manifest.icons ?? []) expect(icon.src.startsWith(`${APP_BASE}icons/`)).toBe(true);
    expect(manifest.icons?.map((icon) => `${icon.sizes}:${icon.purpose ?? 'any'}`)).toEqual(expect.arrayContaining(['192x192:any', '512x512:any', '512x512:maskable']));
  });

  it('only updates after an explicit prompt, never on its own', () => {
    expect(pwaOptions.registerType).toBe('prompt');
    expect(pwaOptions.injectRegister).toBe(false);
    expect(pwaOptions.workbox?.skipWaiting).not.toBe(true);
    expect(pwaOptions.workbox?.clientsClaim).not.toBe(true);
  });

  it('never caches provider traffic: no runtime caching, same-origin navigation fallback only', () => {
    const workbox = pwaOptions.workbox;
    if (!workbox) throw new Error('workbox options missing');
    expect(workbox.runtimeCaching ?? []).toEqual([]);
    expect(workbox.navigateFallback).toBe('index.html');
    expect(workbox.navigateFallbackAllowlist?.every((pattern) => pattern.test('/tennis-stats/matches/1'))).toBe(true);
    expect(workbox.navigateFallbackAllowlist?.some((pattern) => pattern.test('/other/'))).toBe(false);
    const serialized = JSON.stringify(pwaOptions, (_key, value: unknown) => (value instanceof RegExp ? value.source : value)).toLowerCase();
    for (const host of PROVIDER_HOSTS) expect(serialized).not.toContain(host);
    for (const pattern of workbox.globPatterns ?? []) expect(pattern).not.toMatch(/json\b|^\*\*\/\*$/);
  });
});
