/// <reference types="node" />
import 'fake-indexeddb/auto';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dependencies } from '../../app/dependencies';
import type { TennisRepository } from '../../application/ports';
import { openDatabase } from '../../infrastructure/db/database';
import { startMatch } from '../../application/matchService';
import StartMatchPage from './StartMatchPage';

let n = 0;
const repos: Awaited<ReturnType<typeof openDatabase>>[] = [];
let style: HTMLStyleElement;
beforeEach(() => { style = document.createElement('style'); style.textContent = readFileSync(resolve(process.cwd(), 'src/styles/global.css'), 'utf8'); document.head.append(style); });
afterEach(() => { style.remove(); vi.restoreAllMocks(); repos.forEach(repo => repo.close()); repos.length = 0; });
function expectTouchTarget(element: Element) {
  expect(parseFloat(getComputedStyle(element).minHeight)).toBeGreaterThanOrEqual(44);
  expect(parseFloat(getComputedStyle(element).minWidth)).toBeGreaterThanOrEqual(44);
}
async function setup() {
  const repository = await openDatabase(`ui-${++n}`); repos.push(repository);
  const deps = { repository, clock: { now: () => '2026-01-01T12:00:00.000Z' }, ids: { next: () => `ui-id-${++n}` } };
  return deps;
}
function show(deps: Awaited<ReturnType<typeof setup>>) {
  render(<MemoryRouter initialEntries={['/matches/new']}><Routes><Route path="/matches/new" element={<StartMatchPage deps={deps} />} /><Route path="/matches/:id/live" element={<h1>Live placeholder</h1>} /></Routes></MemoryRouter>);
}
it('offers ordered formats, editable date, first server and creates a new opponent', async () => {
  const deps = await setup(); show(deps);
  const format = await screen.findByLabelText('Format');
  expect(Array.from((format as HTMLSelectElement).options).map(o => o.text)).toEqual(['Two sets plus deciding super tie-break', 'Open/practice match with manual completion', 'One set', 'Best of three sets']);
  expect(format).toHaveValue('twoSetsSuperTiebreak');
  for (const control of [format, screen.getByLabelText('Opponent'), screen.getByLabelText('Date and time'), screen.getByRole('button', { name: 'Start match' }), screen.getByLabelText('Player serves first').closest('label')!, screen.getByLabelText('Opponent serves first').closest('label')!]) expectTouchTarget(control);
  for (const value of ['twoSetsSuperTiebreak', 'openPractice', 'oneSet', 'bestOfThree']) {
    fireEvent.change(format, { target: { value } });
    expect(format).toHaveValue(value);
  }
  fireEvent.change(screen.getByLabelText('Opponent'), { target: { value: ' Jamie ' } });
  fireEvent.change(screen.getByLabelText('Date and time'), { target: { value: '2026-02-03T14:30' } });
  fireEvent.click(screen.getByLabelText('Opponent serves first'));
  fireEvent.click(screen.getByRole('button', { name: 'Start match' }));
  await screen.findByText('Live placeholder');
  expect((await deps.repository.getActiveMatch())?.match).toMatchObject({ firstServer: 'opponent', playedAt: new Date('2026-02-03T14:30').toISOString() });
  expect((await deps.repository.listOpponents())[0].name).toBe('Jamie');
});
it('filters suggestions and explicitly resolves an active match', async () => {
  const deps = await setup(); const first = await startMatch({ opponentName: 'Alex', playedAt: deps.clock.now(), firstServer: 'player' }, deps);
  show(deps);
  expect(await screen.findByText(/complete or abandon/i)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /resume/i })).toHaveAttribute('href', `/matches/${first.match.id}/live`);
  expectTouchTarget(screen.getByRole('link', { name: /resume/i }));
  expectTouchTarget(screen.getByRole('button', { name: /abandon active match/i }));
  fireEvent.click(screen.getByRole('button', { name: /abandon active match/i }));
  await waitFor(() => expect(screen.queryByText(/complete or abandon/i)).not.toBeInTheDocument());
  fireEvent.change(screen.getByLabelText('Opponent'), { target: { value: 'ale' } });
  expect(document.querySelector('#opponent-suggestions option[value="Alex"]')).toBeInTheDocument();
  // Browsers apply a datalist selection by setting the associated input's value.
  fireEvent.change(screen.getByLabelText('Opponent'), { target: { value: 'Alex' } });
  fireEvent.click(screen.getByRole('button', { name: 'Start match' }));
  await screen.findByText('Live placeholder');
  expect((await deps.repository.getActiveMatch())?.opponent.id).toBe(first.opponent.id);
  expect(await deps.repository.listOpponents()).toHaveLength(1);
});
it('recovers from a failed repository load on retry', async () => {
  const listOpponents = vi.fn().mockRejectedValueOnce(new Error('List failed')).mockResolvedValue([]);
  const repository = { listOpponents, getActiveMatch: vi.fn().mockResolvedValue(undefined) } as unknown as TennisRepository;
  const deps = { repository, clock: { now: () => '2026-01-01T12:00:00.000Z' }, ids: { next: () => 'id' } };
  render(<MemoryRouter><StartMatchPage deps={deps} /></MemoryRouter>);
  expect(await screen.findByRole('alert')).toHaveTextContent('List failed');
  expect(screen.queryByRole('button', { name: 'Start match' })).not.toBeInTheDocument();
  const retry = screen.getByRole('button', { name: 'Retry' });
  expectTouchTarget(retry);
  fireEvent.click(retry);
  expect(await screen.findByRole('button', { name: 'Start match' })).toBeEnabled();
  expect(listOpponents).toHaveBeenCalledTimes(2);
});
it('reopens the database after an open failure', async () => {
  const repository = { listOpponents: vi.fn().mockResolvedValue([]), getActiveMatch: vi.fn().mockResolvedValue(undefined), close: vi.fn() };
  const open = vi.spyOn(dependencies, 'openDatabase').mockRejectedValueOnce(new Error('Open failed')).mockResolvedValueOnce(repository as unknown as Awaited<ReturnType<typeof dependencies.openDatabase>>);
  render(<MemoryRouter><StartMatchPage /></MemoryRouter>);
  expect(await screen.findByRole('alert')).toHaveTextContent('Open failed');
  expect(screen.queryByRole('button', { name: 'Start match' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByRole('button', { name: 'Start match' })).toBeEnabled();
  expect(open).toHaveBeenCalledTimes(2);
});
it.each([
  ['Two sets plus deciding super tie-break', 'twoSetsSuperTiebreak'],
  ['Open/practice match with manual completion', 'openPractice'],
  ['One set', 'oneSet'],
  ['Best of three sets', 'bestOfThree'],
])('starts a match with selected format %s', async (_label, value) => {
  const deps = await setup(); show(deps);
  const format = await screen.findByLabelText('Format');
  fireEvent.change(format, { target: { value } });
  expect(format).toHaveValue(value);
  fireEvent.change(screen.getByLabelText('Opponent'), { target: { value: 'Jamie' } });
  fireEvent.click(screen.getByRole('button', { name: 'Start match' }));
  await screen.findByText('Live placeholder');
  expect((await deps.repository.getActiveMatch())?.match.format).toBe(value);
});
