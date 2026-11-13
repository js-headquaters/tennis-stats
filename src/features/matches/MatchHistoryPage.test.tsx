/// <reference types="node" />
import 'fake-indexeddb/auto';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { TennisRepository } from '../../application/ports';
import type { Game, MatchBundle, MatchFormat, MatchStatus } from '../../domain/model';
import { openDatabase } from '../../infrastructure/db/database';
import { updateGame } from '../../application/matchService';
import MatchDetailsPage from './MatchDetailsPage';
import MatchHistoryPage from './MatchHistoryPage';

const mocks = vi.hoisted(() => ({ openDatabase: vi.fn() }));
vi.mock('../../app/dependencies', () => ({ dependencies: { openDatabase: mocks.openDatabase, clock: { now: () => new Date(2026, 10, 12, 12).toISOString() }, ids: { next: () => 'id' } } }));

let n = 0;
const repos: TennisRepository[] = [];
let style: HTMLStyleElement;
beforeEach(() => { style = document.createElement('style'); style.textContent = readFileSync(resolve(process.cwd(), 'src/styles/global.css'), 'utf8'); document.head.append(style); });
afterEach(() => { style.remove(); vi.restoreAllMocks(); vi.resetAllMocks(); repos.forEach(repo => repo.close()); repos.length = 0; });

const stamp = { createdAt: '2026-01-01', updatedAt: '2026-01-01' };
function games(setId: string, won: number, lost: number): Game[] {
  return Array.from({ length: won + lost }, (_, index) => ({ ...stamp, id: `${setId}-g${index}`, setId, ordinal: index + 1, server: 'player' as const, result: index < won ? 'won' as const : 'lost' as const, score: null, netErrors: null, wideErrors: null, longErrors: null, doubleFaults: null, failedReturns: null, unforcedErrors: null, comments: null }));
}
function bundle(id: string, opponent: string, playedAt: Date, status: MatchStatus, format: MatchFormat, sets: Array<[number, number]>): MatchBundle {
  const setRows = sets.map(([won, lost], index) => ({ ...stamp, id: `${id}-s${index + 1}`, matchId: id, ordinal: index + 1, kind: 'standard' as const, status: Math.max(won, lost) >= 6 ? 'completed' as const : 'unfinished' as const, tieBreakId: null }));
  return {
    opponent: { ...stamp, id: `o-${opponent}`, name: opponent, normalizedName: opponent.toLowerCase() },
    match: { ...stamp, id, opponentId: `o-${opponent}`, playedAt: playedAt.toISOString(), format, firstServer: 'player', status, comments: null },
    sets: setRows, games: sets.flatMap(([won, lost], index) => games(`${id}-s${index + 1}`, won, lost)), tieBreaks: [],
  };
}
async function seeded(extra: MatchBundle[] = []) {
  const repository = await openDatabase(`history-${++n}`); repos.push(repository);
  const all = [
    bundle('older', 'Alex', new Date(2026, 8, 5, 10), 'completed', 'oneSet', [[6, 2]]),
    bundle('newest', 'Blake', new Date(2026, 10, 10, 18), 'completed', 'bestOfThree', [[6, 4], [6, 2]]),
    bundle('middle', 'Alex', new Date(2026, 9, 1, 9), 'abandoned', 'bestOfThree', [[6, 3], [2, 1]]),
    ...extra,
  ];
  for (const item of all) await repository.saveMatchBundle(item);
  return repository;
}
function show(repository: TennisRepository) {
  render(<MemoryRouter><MatchHistoryPage repository={repository} /></MemoryRouter>);
}
const rows = () => within(screen.getByRole('list', { name: 'Matches' })).getAllByRole('listitem');
const names = () => rows().map(row => within(row).getByRole('link').textContent);

it('lists matches newest first with date, opponent, result, completion state and format as text', async () => {
  show(await seeded());
  await screen.findByRole('list', { name: 'Matches' });
  await waitFor(() => expect(screen.queryByText(/Loading/)).not.toBeInTheDocument());
  expect(names()).toEqual(['Blake', 'Alex', 'Alex']);
  const [newest, middle, older] = rows();
  expect(within(newest).getByRole('link')).toHaveAttribute('href', '/matches/newest');
  expect(newest).toHaveTextContent('10 Nov 2026');
  expect(newest).toHaveTextContent('Completed');
  expect(newest).toHaveTextContent('Best of three sets');
  expect(newest).toHaveTextContent('Won, sets 2–0');
  expect(newest).toHaveTextContent('6–4, 6–2');
  expect(middle).toHaveTextContent('1 Oct 2026');
  expect(middle).toHaveTextContent('Abandoned (unfinished)');
  expect(middle).toHaveTextContent('No result, sets 1–0');
  expect(middle).toHaveTextContent('6–3, 2–1');
  expect(older).toHaveTextContent('5 Sep 2026');
  expect(older).toHaveTextContent('One set');
  expect(older).toHaveTextContent('Won, sets 1–0');
});

it('labels an active match as in progress', async () => {
  show(await seeded([bundle('live', 'Casey', new Date(2026, 10, 11, 9), 'active', 'oneSet', [[1, 0]])]));
  await screen.findByRole('link', { name: 'Casey' });
  expect(rows().find(row => row.textContent?.includes('Casey'))).toHaveTextContent('In progress (unfinished)');
  expect(names()[0]).toBe('Casey');
});

it('filters by reusable opponent', async () => {
  show(await seeded());
  await screen.findByRole('list', { name: 'Matches' });
  const select = screen.getByLabelText('Opponent') as HTMLSelectElement;
  await waitFor(() => expect(Array.from(select.options).map(o => o.text)).toEqual(['All opponents', 'Alex', 'Blake']));
  fireEvent.change(select, { target: { value: select.options[1].value } });
  await waitFor(() => expect(names()).toEqual(['Alex', 'Alex']));
  fireEvent.change(select, { target: { value: '' } });
  await waitFor(() => expect(names()).toHaveLength(3));
});

it('filters by local calendar date range including the whole end day', async () => {
  const late = bundle('late', 'Dana', new Date(2026, 10, 12, 23, 59), 'completed', 'oneSet', [[6, 0]]);
  const repository = await seeded([late, bundle('next', 'Eli', new Date(2026, 10, 13, 0, 0), 'completed', 'oneSet', [[6, 1]])]);
  show(repository);
  await screen.findByRole('list', { name: 'Matches' });
  fireEvent.change(screen.getByLabelText('From date'), { target: { value: '2026-10-01' } });
  fireEvent.change(screen.getByLabelText('To date'), { target: { value: '2026-11-12' } });
  await waitFor(() => expect(names()).toEqual(['Dana', 'Blake', 'Alex']));
  fireEvent.change(screen.getByLabelText('From date'), { target: { value: '2026-11-11' } });
  await waitFor(() => expect(names()).toEqual(['Dana']));
  fireEvent.change(screen.getByLabelText('To date'), { target: { value: '' } });
  await waitFor(() => expect(names()).toEqual(['Eli', 'Dana']));
});

it('explains an empty result and keeps filters usable', async () => {
  show(await seeded());
  await screen.findByRole('list', { name: 'Matches' });
  fireEvent.change(screen.getByLabelText('From date'), { target: { value: '2027-01-01' } });
  expect(await screen.findByText('No matches match these filters.')).toBeInTheDocument();
  expect(screen.queryByRole('list', { name: 'Matches' })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('From date'), { target: { value: '' } });
  await screen.findByRole('list', { name: 'Matches' });
});

it('shows a distinct empty state when no matches exist at all', async () => {
  const repository = await openDatabase(`history-${++n}`); repos.push(repository);
  show(repository);
  expect(await screen.findByText('No matches recorded yet.')).toBeInTheDocument();
});

it('flags an inverted date range in text', async () => {
  show(await seeded());
  await screen.findByRole('list', { name: 'Matches' });
  fireEvent.change(screen.getByLabelText('From date'), { target: { value: '2026-11-12' } });
  fireEvent.change(screen.getByLabelText('To date'), { target: { value: '2026-11-01' } });
  expect(await screen.findByText('The start date is after the end date.')).toBeInTheDocument();
});

it('recovers from a load error with Retry and closes an owned repository', async () => {
  const real = await seeded();
  const close = vi.fn();
  mocks.openDatabase.mockRejectedValueOnce(new Error('blocked')).mockResolvedValueOnce(Object.create(real, { close: { value: close } }));
  render(<MemoryRouter><MatchHistoryPage /></MemoryRouter>);
  expect(await screen.findByRole('alert')).toHaveTextContent('Unable to load matches.');
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(names()).toEqual(['Blake', 'Alex', 'Alex']));
  await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
});

it('keeps listing other matches when one result cannot be loaded, and can retry', async () => {
  const repository = await seeded();
  const original = repository.getMatchBundle.bind(repository);
  let failing = true;
  vi.spyOn(repository, 'getMatchBundle').mockImplementation(async id => { if (id === 'middle' && failing) throw new Error('corrupt'); return original(id); });
  show(repository);
  await waitFor(() => expect(names()).toEqual(['Blake', 'Alex', 'Alex']));
  const middle = rows()[1];
  expect(middle).toHaveTextContent('Result unavailable');
  expect(middle).toHaveTextContent('Abandoned (unfinished)');
  expect(rows()[0]).toHaveTextContent('Won, sets 2–0');
  failing = false;
  fireEvent.click(screen.getByRole('button', { name: 'Retry loading results' }));
  await waitFor(() => expect(rows()[1]).toHaveTextContent('6–3, 2–1'));
  expect(screen.queryByRole('button', { name: 'Retry loading results' })).not.toBeInTheDocument();
});

it('uses 44px targets for filters, retry and match links', async () => {
  show(await seeded());
  await screen.findByRole('list', { name: 'Matches' });
  for (const element of [screen.getByLabelText('Opponent'), screen.getByLabelText('From date'), screen.getByLabelText('To date'), within(rows()[0]).getByRole('link')]) {
    expect(parseFloat(getComputedStyle(element).minHeight)).toBeGreaterThanOrEqual(44);
  }
});

const fixedDeps = (repository: TennisRepository) => ({ repository, clock: { now: () => '2026-11-12T12:00:00.000Z' }, ids: { next: () => `id-${++n}` } });
async function detailsResult(repository: TennisRepository, id: string) {
  const view = render(<MemoryRouter initialEntries={[`/matches/${id}`]}><Routes><Route path="/matches/:matchId" element={<MatchDetailsPage deps={fixedDeps(repository)} />} /></Routes></MemoryRouter>);
  await screen.findByRole('heading', { level: 1, name: /Match against/ });
  const text = screen.getByText(/^(Won|Lost|No result), sets/, { selector: 'dd' }).textContent; view.unmount(); return text;
}
async function historyResult(repository: TennisRepository, opponent: string) {
  const view = render(<MemoryRouter><MatchHistoryPage repository={repository} /></MemoryRouter>);
  await screen.findByRole('link', { name: opponent });
  const row = rows().find(item => item.textContent?.includes(opponent))!;
  await waitFor(() => expect(row).toHaveTextContent(/sets \d/));
  const text = /(Won|Lost|No result), sets \d–\d/.exec(row.textContent ?? '')![0]; view.unmount(); return text;
}

it('ignores an early-ended set in a two-sets-plus-super-tie-break result, like the details page', async () => {
  const repository = await seeded([bundle('early', 'Fran', new Date(2026, 10, 11, 10), 'completed', 'twoSetsSuperTiebreak', [[2, 1], [6, 0], [6, 1]])]);
  expect(await historyResult(repository, 'Fran')).toBe('Won, sets 2–0');
  expect(await detailsResult(repository, 'early')).toBe('Won, sets 2–0');
});

it('agrees with the details page after an unfinished set\'s games are corrected into a decisive score', async () => {
  const repository = await seeded([bundle('fix', 'Gale', new Date(2026, 10, 11, 10), 'completed', 'bestOfThree', [[5, 1], [6, 0], [6, 0]])]);
  const corrected = await updateGame('fix-s1-g5', { result: 'won' }, fixedDeps(repository));
  expect(corrected.conflicts).toEqual([]);
  expect(corrected.bundle.sets[0].status).toBe('unfinished');
  expect(await historyResult(repository, 'Gale')).toBe('Won, sets 2–0');
  expect(await detailsResult(repository, 'fix')).toBe('Won, sets 2–0');
});
