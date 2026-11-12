/// <reference types="node" />
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { TennisRepository } from '../../application/ports';
import type { Game, MatchBundle, MatchStatus, Server } from '../../domain/model';
import DashboardPage from './DashboardPage';

const mocks = vi.hoisted(() => ({ openDatabase: vi.fn() }));
vi.mock('../../app/dependencies', () => ({ dependencies: { openDatabase: mocks.openDatabase, clock: { now: () => new Date(2026, 10, 12, 12).toISOString() } } }));
afterEach(() => vi.resetAllMocks());

it('shows a prominent resume card and keeps the start action when a match is active', async () => {
  const close = vi.fn();
  mocks.openDatabase.mockResolvedValue({
    getActiveMatch: async () => ({ match: { id: 'match-1' }, opponent: { name: 'Alex' } }),
    listMatches: async () => [],
    close,
  });
  render(<MemoryRouter><DashboardPage /></MemoryRouter>);

  const card = await screen.findByRole('region', { name: 'Active match' });
  const statistics = screen.getByRole('region', { name: 'Statistics' });
  expect(within(statistics).getByRole('heading', { name: 'Statistics' })).toBeInTheDocument();
  expect(statistics.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(within(card).getByRole('heading', { name: 'Match in progress' })).toBeInTheDocument();
  expect(within(card).getByText('Against Alex')).toBeInTheDocument();
  expect(within(card).getByRole('link', { name: 'Resume match' })).toHaveAttribute('href', '/matches/match-1/live');
  expect(screen.getByRole('link', { name: 'Start new match' })).toHaveAttribute('href', '/matches/new');
  await waitFor(() => expect(close).toHaveBeenCalled());
});

it('keeps the start action without a resume card when no match is active', async () => {
  const close = vi.fn();
  mocks.openDatabase.mockResolvedValue({ getActiveMatch: async () => undefined, listMatches: async () => [], close });
  render(<MemoryRouter><DashboardPage /></MemoryRouter>);

  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(screen.queryByRole('link', { name: 'Resume match' })).not.toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Active match' })).not.toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Statistics' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Start new match' })).toHaveAttribute('href', '/matches/new');
});

// ---- Statistics-first dashboard (Task 9) ----

type Values = [net: number | null, wide: number | null, long: number | null, df: number | null, fr: number | null];
let seq = 0;
function game(server: Server, [netErrors, wideErrors, longErrors, doubleFaults, failedReturns]: Values): Game {
  const id = `g-${++seq}`;
  return { id, createdAt: '', updatedAt: '', setId: 's', ordinal: seq, server, result: 'won', score: null, netErrors, wideErrors, longErrors, doubleFaults, failedReturns };
}
function bundle(id: string, opponent: string, playedAt: Date, status: MatchStatus, games: Game[]): MatchBundle {
  return {
    match: { id, createdAt: '', updatedAt: '', opponentId: `o-${id}`, playedAt: playedAt.toISOString(), format: 'twoSetsSuperTiebreak', firstServer: 'player', status, comments: null },
    opponent: { id: `o-${id}`, createdAt: '', updatedAt: '', name: opponent, normalizedName: opponent.toLowerCase() },
    sets: [], games, tieBreaks: [],
  };
}
// Reference: Thursday 12 Nov 2026 (local). Current week Mon 9 – Sun 15 Nov; previous week 2–8 Nov.
const reference = new Date(2026, 10, 12, 12);
const fixtures = [
  bundle('alex', 'Alex', new Date(2026, 10, 10, 10), 'completed', [
    game('player', [1, 0, 2, 1, null]),
    game('opponent', [2, null, 0, null, 1]),
    game('opponent', [0, 1, null, null, 0]),
  ]),
  bundle('blake', 'Blake', new Date(2026, 10, 4, 18), 'abandoned', [
    game('player', [3, 0, 1, 0, null]),
    game('opponent', [1, 0, null, null, null]),
  ]),
  bundle('casey', 'Casey', new Date(2026, 9, 20, 9), 'completed', [game('player', [5, null, null, null, null])]),
  bundle('drew', 'Drew', new Date(2026, 10, 11, 19), 'active', []),
];
function fakeRepository(bundles: MatchBundle[]) {
  return {
    getActiveMatch: vi.fn(async () => bundles.find(b => b.match.status === 'active')),
    listMatches: vi.fn(async () => bundles.map(b => b.match)),
    getMatchBundle: vi.fn(async (id: string) => bundles.find(b => b.match.id === id)),
    close: vi.fn(),
  };
}
function show(repository = fakeRepository(fixtures)) {
  render(<MemoryRouter><DashboardPage repository={repository as unknown as TennisRepository} clock={{ now: () => reference.toISOString() }} /></MemoryRouter>);
  return repository;
}
function card(name: string) { return screen.getByRole('article', { name }); }
function value(name: string, term: string) {
  return within(card(name)).getByText(term, { selector: 'dt' }).nextElementSibling as HTMLElement;
}

it('shows per-game averages, sample sizes and neutral trends for the current calendar week', async () => {
  show();
  expect(await screen.findByRole('heading', { name: '9–15 Nov 2026' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Week' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: 'Month' })).toHaveAttribute('aria-pressed', 'false');

  expect(value('Net errors', 'Average')).toHaveTextContent(/^1$/);
  expect(value('Net errors', 'Sample')).toHaveTextContent('3 games');
  expect(value('Net errors', 'Trend')).toHaveTextContent('1 lower than the previous week (2 across 2 games)');
  expect(value('Wide errors', 'Average')).toHaveTextContent('0.5');
  expect(value('Wide errors', 'Sample')).toHaveTextContent('2 games');
  expect(value('Wide errors', 'Trend')).toHaveTextContent('0.5 higher than the previous week (0 across 2 games)');
  expect(value('Long errors', 'Average')).toHaveTextContent(/^1$/);
  expect(value('Long errors', 'Trend')).toHaveTextContent('Same as the previous week (1 across 1 game)');
  expect(value('Double faults', 'Average')).toHaveTextContent(/^1$/);
  expect(value('Double faults', 'Sample')).toHaveTextContent('1 service game');
  expect(value('Failed returns', 'Average')).toHaveTextContent('0.5');
  expect(value('Failed returns', 'Sample')).toHaveTextContent('2 return games');
  expect(value('Failed returns', 'Trend')).toHaveTextContent('No comparison: no recorded return games in the previous week');
  expect(within(card('Net errors')).getByRole('figure', { name: /trend/ })).toBeInTheDocument();
});

it('navigates to earlier weeks and back to later ones, never past the current week', async () => {
  show();
  await screen.findByRole('heading', { name: '9–15 Nov 2026' });
  expect(screen.getByRole('button', { name: 'Next week' })).toBeDisabled();

  fireEvent.click(screen.getByRole('button', { name: 'Previous week' }));
  expect(screen.getByRole('heading', { name: '2–8 Nov 2026' })).toBeInTheDocument();
  expect(value('Net errors', 'Average')).toHaveTextContent(/^2$/);
  expect(value('Wide errors', 'Average')).toHaveTextContent(/^0$/);
  expect(value('Net errors', 'Trend')).toHaveTextContent('No comparison: no recorded games in the previous week');
  expect(within(value('Failed returns', 'Average')).getByLabelText('unknown')).toHaveTextContent('—');
  expect(value('Failed returns', 'Sample')).toHaveTextContent('0 return games');
  expect(value('Failed returns', 'Trend')).toHaveTextContent('No comparison: no recorded return games in the selected or previous week');

  fireEvent.click(screen.getByRole('button', { name: 'Previous week' }));
  expect(screen.getByRole('heading', { name: '26 Oct – 1 Nov 2026' })).toBeInTheDocument();
  // Casey (20 Oct) is in the week before, so only the selected week lacks a sample.
  expect(value('Net errors', 'Trend')).toHaveTextContent('No comparison: no recorded games in the selected week');

  fireEvent.click(screen.getByRole('button', { name: 'Next week' }));
  fireEvent.click(screen.getByRole('button', { name: 'Next week' }));
  expect(screen.getByRole('heading', { name: '9–15 Nov 2026' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Next week' })).toBeDisabled();
});

it('switches to calendar months and compares with the previous month', async () => {
  show();
  await screen.findByRole('heading', { name: '9–15 Nov 2026' });
  fireEvent.click(screen.getByRole('button', { name: 'Month' }));
  expect(screen.getByRole('button', { name: 'Month' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('heading', { name: 'November 2026' })).toBeInTheDocument();
  expect(value('Net errors', 'Average')).toHaveTextContent('1.4');
  expect(value('Net errors', 'Sample')).toHaveTextContent('5 games');
  expect(value('Net errors', 'Trend')).toHaveTextContent('3.6 lower than the previous month (5 across 1 game)');
  expect(screen.getByRole('button', { name: 'Next month' })).toBeDisabled();

  fireEvent.click(screen.getByRole('button', { name: 'Previous month' }));
  expect(screen.getByRole('heading', { name: 'October 2026' })).toBeInTheDocument();
  expect(value('Net errors', 'Average')).toHaveTextContent(/^5$/);
  expect(value('Net errors', 'Sample')).toHaveTextContent('1 game');

  fireEvent.click(screen.getByRole('button', { name: 'Week' }));
  expect(screen.getByRole('heading', { name: '9–15 Nov 2026' })).toBeInTheDocument();
});

it('never shows raw error totals', async () => {
  show();
  await screen.findByRole('heading', { name: '9–15 Nov 2026' });
  const statistics = screen.getByRole('region', { name: 'Statistics' });
  expect(statistics).not.toHaveTextContent(/total/i);
  // Current-week sums: net 3, long 2; the averages are 1 and the sample sizes are "3 games"/"2 games".
  expect(value('Net errors', 'Average')).not.toHaveTextContent('3');
  expect(value('Long errors', 'Average')).not.toHaveTextContent('2');
  fireEvent.click(screen.getByRole('button', { name: 'Month' }));
  // November net-error sum is 7; only the 1.4 average may appear.
  expect(statistics).not.toHaveTextContent(/(^|[^.\d])7([^.\d]|$)/);
});

it('lists recent matches newest first below the statistics and shows the active match card', async () => {
  show();
  const recent = await screen.findByRole('region', { name: 'Recent matches' });
  const statistics = screen.getByRole('region', { name: 'Statistics' });
  expect(statistics.compareDocumentPosition(recent) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const items = within(recent).getAllByRole('listitem');
  expect(items.map(item => within(item).getByRole('link').textContent)).toEqual(['Drew', 'Alex', 'Blake', 'Casey']);
  expect(items[0]).toHaveTextContent('In progress');
  expect(items[2]).toHaveTextContent('Abandoned');
  expect(within(items[1]).getByRole('link')).toHaveAttribute('href', '/matches/alex');
  const active = screen.getByRole('region', { name: 'Active match' });
  expect(within(active).getByText('Against Drew')).toBeInTheDocument();
  expect(within(active).getByRole('link', { name: 'Resume match' })).toHaveAttribute('href', '/matches/drew/live');
});

it('does not close an injected repository', async () => {
  const repository = show();
  await screen.findByRole('heading', { name: '9–15 Nov 2026' });
  expect(repository.close).not.toHaveBeenCalled();
});

it('shows an empty state without implying a trend when nothing is recorded', async () => {
  show(fakeRepository([]));
  await screen.findByRole('heading', { name: '9–15 Nov 2026' });
  expect(within(value('Net errors', 'Average')).getByLabelText('unknown')).toBeInTheDocument();
  expect(value('Net errors', 'Trend')).toHaveTextContent('No comparison');
  expect(screen.getByText('No matches recorded yet.')).toBeInTheDocument();
});

it('recovers from a load failure with retry', async () => {
  const close = vi.fn();
  mocks.openDatabase.mockRejectedValueOnce(new Error('blocked')).mockResolvedValueOnce({ ...fakeRepository(fixtures), close });
  render(<MemoryRouter><DashboardPage clock={{ now: () => reference.toISOString() }} /></MemoryRouter>);
  expect(await screen.findByRole('alert')).toHaveTextContent('Unable to load statistics.');
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByRole('heading', { name: '9–15 Nov 2026' })).toBeInTheDocument();
  await screen.findByText('Against Drew');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  await waitFor(() => expect(close).toHaveBeenCalled());
});

it('gives controls 44px touch targets and keeps the start action floating', async () => {
  const style = document.createElement('style');
  style.textContent = readFileSync(resolve(process.cwd(), 'src/styles/global.css'), 'utf8');
  document.head.append(style);
  try {
    show();
    await screen.findByRole('heading', { name: '9–15 Nov 2026' });
    for (const name of ['Week', 'Month', 'Previous week', 'Next week']) {
      const control = screen.getByRole('button', { name });
      expect(parseFloat(getComputedStyle(control).minHeight)).toBeGreaterThanOrEqual(44);
      expect(parseFloat(getComputedStyle(control).minWidth)).toBeGreaterThanOrEqual(44);
    }
    for (const link of [screen.getByRole('link', { name: 'Start new match' }), screen.getByRole('link', { name: 'Resume match' }), screen.getByRole('link', { name: 'Alex' })]) {
      expect(parseFloat(getComputedStyle(link).minHeight)).toBeGreaterThanOrEqual(44);
    }
    expect(getComputedStyle(screen.getByRole('link', { name: 'Start new match' })).position).toBe('fixed');
  } finally { style.remove(); }
});
