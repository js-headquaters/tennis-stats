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
