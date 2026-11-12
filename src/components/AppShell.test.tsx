import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import AppShell from './AppShell';
import type { RecoveryStatus } from '../application/ports';

describe('AppShell lifecycle UI', () => {
  it('mounts connectivity and update status outside the routed content', async () => {
    const connectivity = { isOnline: () => false, subscribe: () => () => {} };
    const updateController = { getNeedRefresh: () => true, subscribe: () => () => {}, applyUpdate: vi.fn(async () => {}) };
    const workGuard = { check: async () => 'safe' as const, subscribe: () => () => {} };
    render(<MemoryRouter><Routes><Route element={<AppShell connectivity={connectivity} updateController={updateController} workGuard={workGuard} loadRecoveryStatus={async () => ({ mode: 'normal' })} />}><Route path="/" element={<p>Routed page</p>} /></Route></Routes></MemoryRouter>);
    const main = screen.getByRole('main');
    expect(within(main).getByText('Routed page')).toBeInTheDocument();
    expect(screen.getByText(/you're offline/i)).toBeInTheDocument();
    expect(main).not.toContainElement(screen.getByText(/you're offline/i));
    const reload = await screen.findByRole('button', { name: 'Reload to update' });
    expect(main).not.toContainElement(reload);
    expect(updateController.applyUpdate).not.toHaveBeenCalled();
    expect(screen.getByRole('navigation', { name: /main/i })).toBeInTheDocument();
  });
});

describe('AppShell recovery banner', () => {
  const connectivity = { isOnline: () => true, subscribe: () => () => {} };
  const updateController = { getNeedRefresh: () => false, subscribe: () => () => {}, applyUpdate: async () => {} };
  const diagnostics = { code: 'newer-data-version' as const, message: 'This data was saved by a newer version of the app.', failedStep: null, storedDataVersion: 3, appDataVersion: 2, appVersion: null, errorName: 'Error' };
  function renderAt(path: string, loadRecoveryStatus: () => Promise<RecoveryStatus>) {
    render(<MemoryRouter initialEntries={[path]}><Routes><Route element={<AppShell connectivity={connectivity} updateController={updateController} loadRecoveryStatus={loadRecoveryStatus} />}><Route path="/" element={<p>Home page</p>} /><Route path="/matches/:id/live" element={<p>Live page</p>} /></Route></Routes></MemoryRouter>);
  }
  it.each(['/', '/matches/m/live'])('shows the read-only banner outside the routed content on %s', async path => {
    const load = vi.fn(async (): Promise<RecoveryStatus> => ({ mode: 'readOnly', diagnostics }));
    renderAt(path, load);
    const banner = await screen.findByRole('region', { name: 'Read-only recovery mode' });
    expect(screen.getByRole('main')).not.toContainElement(banner);
    expect(load).toHaveBeenCalledTimes(1);
  });
  it('shows no banner in normal mode or when the status cannot be read', async () => {
    const load = vi.fn(async (): Promise<RecoveryStatus> => ({ mode: 'normal' }));
    renderAt('/', load);
    await waitFor(() => expect(load).toHaveBeenCalled());
    expect(screen.queryByRole('region', { name: 'Read-only recovery mode' })).not.toBeInTheDocument();
    cleanup();
    const failing = vi.fn(async (): Promise<RecoveryStatus> => { throw new Error('no db'); });
    renderAt('/', failing);
    await waitFor(() => expect(failing).toHaveBeenCalled());
    expect(screen.queryByRole('region', { name: 'Read-only recovery mode' })).not.toBeInTheDocument();
  });
});

describe('AppShell layout', () => {
  it('reserves room below the page content for the fixed bottom navigation, so the last control is never covered', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync(`${process.cwd()}/src/styles/global.css`, 'utf8');
    // The fixed nav is .5rem + 44px + .5rem (+ safe-area inset) tall; main must pad at least that much below its content.
    const main = /(?:^|[}\s])main\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    // `padding: <top> <sides> calc(<n>rem + env(safe-area-inset-bottom))` (or padding-bottom with the same calc).
    const reserve = /padding(?:-bottom)?\s*:[^;]*calc\(\s*([\d.]+)rem\s*\+\s*env\(safe-area-inset-bottom\)\s*\)/.exec(main);
    expect(reserve, 'main has a bottom padding that includes the safe-area inset').not.toBeNull();
    expect(parseFloat(reserve![1])).toBeGreaterThanOrEqual(4);
  });
});
