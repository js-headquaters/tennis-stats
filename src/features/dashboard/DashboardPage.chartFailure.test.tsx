import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import type { TennisRepository } from '../../application/ports';
import type { MatchBundle } from '../../domain/model';
import DashboardPage from './DashboardPage';

// Simulates the lazily loaded Recharts chunk failing to load (e.g. offline after a deploy).
vi.mock('./TrendLines', () => { throw new Error('Failed to fetch dynamically imported module'); });
afterEach(() => vi.restoreAllMocks());

const active: MatchBundle = {
  match: { id: 'm1', createdAt: '', updatedAt: '', opponentId: 'o1', playedAt: new Date(2026, 10, 10, 10).toISOString(), format: 'oneSet', firstServer: 'player', status: 'active', comments: null },
  opponent: { id: 'o1', createdAt: '', updatedAt: '', name: 'Alex', normalizedName: 'alex' },
  sets: [], tieBreaks: [],
  games: [{ id: 'g1', createdAt: '', updatedAt: '', setId: 's', ordinal: 1, server: 'player', result: 'won', score: null, netErrors: 2, wideErrors: 0, longErrors: 1, doubleFaults: 0, failedReturns: null }],
};

it('keeps Home usable with text equivalents when the chart chunk fails to load', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const repository = { getActiveMatch: async () => active, listMatches: async () => [active.match], getMatchBundle: async () => active, close: vi.fn() };
  render(<MemoryRouter><DashboardPage repository={repository as unknown as TennisRepository} clock={{ now: () => new Date(2026, 10, 12, 12).toISOString() }} /></MemoryRouter>);

  const statistics = await screen.findByRole('region', { name: 'Statistics' });
  await screen.findByRole('heading', { name: '9–15 Nov 2026' });
  expect(await within(statistics).findAllByTestId('trend-chart-unavailable')).toHaveLength(3);
  expect(within(statistics).getAllByRole('article')).toHaveLength(3);
  expect(within(statistics).getByRole('table', { name: 'Unforced errors per recorded game by period' })).toBeInTheDocument();
  expect(within(screen.getByRole('region', { name: 'Active match' })).getByRole('link', { name: 'Resume match' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Start new match' })).toBeInTheDocument();
});
