import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, within } from '@testing-library/react';
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

it('gives the game form controls and disclosure 44px touch targets', async () => {
  const now = '2026-01-01T00:00:00.000Z';
  const bundle = { opponent: { id: 'o', name: 'Alex', normalizedName: 'alex', createdAt: now, updatedAt: now }, match: { id: 'm', opponentId: 'o', playedAt: now, format: 'oneSet', firstServer: 'player', status: 'active', comments: null, createdAt: now, updatedAt: now }, sets: [{ id: 's', matchId: 'm', ordinal: 1, kind: 'standard', status: 'active', tieBreakId: null, createdAt: now, updatedAt: now }], games: [], tieBreaks: [] };
  const repository = { getMatchBundle: vi.fn().mockResolvedValue(bundle), close: vi.fn(), getRecoveryStatus: () => ({ mode: 'normal' as const }) } as unknown as TennisRepository;
  const deps = { repository, clock: { now: () => now }, ids: { next: () => 'id' } };
  render(<MemoryRouter initialEntries={['/matches/m/live']}><Routes><Route path="/matches/:matchId/live" element={<ActiveMatchPage deps={deps} />} /></Routes></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: 'Manual game entry' }));
  const form = within(screen.getByRole('form', { name: 'Manual game entry' }));
  fireEvent.click(form.getByText('Add details'));
  expect44([form.getByText('Add details'), form.getByLabelText('Unforced errors'), form.getByLabelText('Double faults'), form.getByLabelText('Net errors'), form.getByLabelText('Wide errors'), form.getByLabelText('Long errors'), form.getByLabelText('Game comment'), form.getByLabelText('Result'), form.getByLabelText('Server')]);
});
