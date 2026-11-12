import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import SettingsPage from '../features/settings/SettingsPage';
import ActiveMatchPage from '../features/matches/ActiveMatchPage';
import { createLocalSettings } from '../infrastructure/settings/localSettings';
import { NotFoundPage, RouteErrorPage } from '../components/RouteFallback';
import type { TennisRepository } from '../application/ports';

let style: HTMLStyleElement;
beforeEach(() => { localStorage.clear(); style = document.createElement('style'); style.textContent = readFileSync(resolve(process.cwd(), 'src/styles/global.css'), 'utf8'); document.head.append(style); });
afterEach(() => style.remove());
const size = (element: HTMLElement) => { const css = getComputedStyle(element); return [parseFloat(css.minHeight), parseFloat(css.minWidth)]; };
const expect44 = (elements: HTMLElement[]) => { expect(elements.length).toBeGreaterThan(0); for (const element of elements) for (const value of size(element)) expect(value).toBeGreaterThanOrEqual(44); };

it('gives AI settings controls 44px touch targets', () => {
  render(<SettingsPage store={createLocalSettings(localStorage)} testConnection={vi.fn()} />);
  for (const name of ['Transcription', 'Statistics parser']) {
    const section = within(screen.getByRole('group', { name }));
    expect44([...section.getAllByRole('button'), section.getByLabelText('Provider'), section.getByLabelText('Model'), section.getByLabelText('Endpoint (optional)'), section.getByLabelText('API key')]);
  }
});

it('gives the live match load-error controls 44px touch targets', async () => {
  const repository = { getMatchBundle: vi.fn().mockRejectedValue(new Error('offline')), close: vi.fn(), getRecoveryStatus: () => ({ mode: 'normal' as const }) } as unknown as TennisRepository;
  const deps = { repository, clock: { now: () => 'x' }, ids: { next: () => 'id' } };
  render(<MemoryRouter initialEntries={['/matches/m/live']}><Routes><Route path="/matches/:matchId/live" element={<ActiveMatchPage deps={deps} />} /></Routes></MemoryRouter>);
  await screen.findByRole('alert');
  expect44([screen.getByRole('button', { name: 'Retry' }), screen.getByRole('link', { name: 'Matches' })]);
});

it('gives the not-found and error fallback links 44px touch targets', () => {
  render(<MemoryRouter><NotFoundPage /><RouteErrorPage /></MemoryRouter>);
  expect44(screen.getAllByRole('link'));
});
