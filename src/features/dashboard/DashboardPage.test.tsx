import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import DashboardPage from './DashboardPage';

const mocks = vi.hoisted(() => ({ openDatabase: vi.fn() }));
vi.mock('../../app/dependencies', () => ({ dependencies: { openDatabase: mocks.openDatabase } }));
afterEach(() => vi.resetAllMocks());

it('shows a prominent resume card and keeps the start action when a match is active', async () => {
  const close = vi.fn();
  mocks.openDatabase.mockResolvedValue({
    getActiveMatch: async () => ({ match: { id: 'match-1' }, opponent: { name: 'Alex' } }),
    close,
  });
  render(<MemoryRouter><DashboardPage /></MemoryRouter>);

  const card = await screen.findByRole('region', { name: 'Active match' });
  expect(within(card).getByRole('heading', { name: 'Match in progress' })).toBeInTheDocument();
  expect(within(card).getByText('Against Alex')).toBeInTheDocument();
  expect(within(card).getByRole('link', { name: 'Resume match' })).toHaveAttribute('href', '/matches/match-1/live');
  expect(screen.getByRole('link', { name: 'Start new match' })).toHaveAttribute('href', '/matches/new');
  await waitFor(() => expect(close).toHaveBeenCalled());
});

it('keeps the start action without a resume card when no match is active', async () => {
  const close = vi.fn();
  mocks.openDatabase.mockResolvedValue({ getActiveMatch: async () => undefined, close });
  render(<MemoryRouter><DashboardPage /></MemoryRouter>);

  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(screen.queryByRole('link', { name: 'Resume match' })).not.toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Active match' })).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Start new match' })).toHaveAttribute('href', '/matches/new');
});
