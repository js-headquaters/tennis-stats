import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import AppShell from './AppShell';

describe('AppShell lifecycle UI', () => {
  it('mounts connectivity and update status outside the routed content', async () => {
    const connectivity = { isOnline: () => false, subscribe: () => () => {} };
    const updateController = { getNeedRefresh: () => true, subscribe: () => () => {}, applyUpdate: vi.fn(async () => {}) };
    const workGuard = { check: async () => 'safe' as const, subscribe: () => () => {} };
    render(<MemoryRouter><Routes><Route element={<AppShell connectivity={connectivity} updateController={updateController} workGuard={workGuard} />}><Route path="/" element={<p>Routed page</p>} /></Route></Routes></MemoryRouter>);
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
