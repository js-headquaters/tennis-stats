/// <reference types="node" />
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { startMatch, type MatchServiceDeps } from '../../application/matchService';
import type { TennisRepository } from '../../application/ports';
import type { Game, MatchBundle, MatchDiagnostic, MatchStatus, Server } from '../../domain/model';
import { FileTransferError, type FileTransfer } from '../../infrastructure/backup/fileTransfer';
import { openDatabase } from '../../infrastructure/db/database';
import MatchDetailsPage from './MatchDetailsPage';

const mocks = vi.hoisted(() => ({ openDatabase: vi.fn() }));
vi.mock('../../app/dependencies', () => ({ dependencies: { openDatabase: mocks.openDatabase, clock: { now: () => '2026-11-12T12:00:00.000Z' }, ids: { next: () => 'owned-id' } } }));

let n = 0;
const repos: TennisRepository[] = [];
afterEach(() => { vi.resetAllMocks(); repos.forEach(repo => repo.close()); repos.length = 0; });

const stamp = { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
const none = { netErrors: null, wideErrors: null, longErrors: null, doubleFaults: null, failedReturns: null, unforcedErrors: null, comments: null };
function game(setId: string, ordinal: number, result: Game['result'], extra: Partial<Game> = {}): Game {
  const server: Server = ordinal % 2 ? 'player' : 'opponent';
  return { ...stamp, ...none, id: `${setId}-g${ordinal}`, setId, ordinal, server, result, score: null, ...extra };
}
/** Best of three, won 2–0: set 1 6–4, set 2 7–6 via a 7–3 standard tie-break. */
function completed(status: MatchStatus = 'completed'): MatchBundle {
  const set1 = ['won', 'won', 'lost', 'won', 'lost', 'won', 'lost', 'won', 'lost', 'won'] as const;
  const set1Games = set1.map((result, i) => game('s1', i + 1, result, i === 0 ? { netErrors: 0, longErrors: 0 } : i === 1 ? { netErrors: 2 } : {}));
  const set2Games = Array.from({ length: 12 }, (_, i) => game('s2', i + 1, i % 2 ? 'lost' : 'won'));
  return {
    opponent: { ...stamp, id: 'o1', name: 'Alex', normalizedName: 'alex' },
    match: { ...stamp, id: 'm1', opponentId: 'o1', playedAt: new Date(2026, 10, 10, 18, 30).toISOString(), format: 'bestOfThree', firstServer: 'player', status, comments: 'Felt sharp' },
    sets: [
      { ...stamp, id: 's1', matchId: 'm1', ordinal: 1, kind: 'standard', status: 'completed', tieBreakId: null },
      { ...stamp, id: 's2', matchId: 'm1', ordinal: 2, kind: 'standard', status: 'completed', tieBreakId: 't2' },
    ],
    games: [...set1Games, ...set2Games],
    tieBreaks: [{ ...stamp, id: 't2', setId: 's2', kind: 'standard', playerPoints: 7, opponentPoints: 3, netErrors: 1, wideErrors: null, longErrors: null, doubleFaults: null }],
  };
}
/** Abandoned one-set match with an unfinished set at 2–1. */
function abandoned(): MatchBundle {
  return {
    opponent: { ...stamp, id: 'o2', name: 'Blake', normalizedName: 'blake' },
    match: { ...stamp, id: 'm2', opponentId: 'o2', playedAt: new Date(2026, 10, 1, 9, 0).toISOString(), format: 'oneSet', firstServer: 'player', status: 'abandoned', comments: null },
    sets: [{ ...stamp, id: 'u1', matchId: 'm2', ordinal: 1, kind: 'standard', status: 'unfinished', tieBreakId: null }],
    games: [game('u1', 1, 'won'), game('u1', 2, 'lost'), game('u1', 3, 'won')],
    tieBreaks: [],
  };
}
async function seeded(...bundles: MatchBundle[]) {
  const repository = await openDatabase(`details-${++n}`); repos.push(repository);
  for (const bundle of bundles) await repository.saveMatchBundle(bundle);
  let id = 0;
  return { repository, clock: { now: () => '2026-11-12T12:00:00.000Z' }, ids: { next: () => `new-${++id}` } } satisfies MatchServiceDeps;
}
function show(deps: MatchServiceDeps | undefined, id = 'm1', transfer?: FileTransfer) {
  return render(<MemoryRouter initialEntries={[`/matches/${id}`]}><Routes><Route path="/matches/:matchId" element={<MatchDetailsPage deps={deps} transfer={transfer} />} /></Routes></MemoryRouter>);
}
const set = (ordinal: number) => screen.getByRole('region', { name: `Set ${ordinal}` });
const stored = async (deps: MatchServiceDeps, id = 'm1') => (await deps.repository.getMatchBundle(id))!;

it('shows match context, sets with derived scores, games and tie-break summaries in text', async () => {
  show(await seeded(completed()));
  expect(await screen.findByRole('heading', { level: 1, name: 'Match against Alex' })).toBeInTheDocument();
  expect(screen.getByText('10 Nov 2026, 18:30')).toBeInTheDocument();
  expect(screen.getByText('Best of three sets', { selector: 'dd' })).toBeInTheDocument();
  expect(screen.getByText('Completed')).toBeInTheDocument();
  expect(screen.getByText('Won, sets 2–0')).toBeInTheDocument();
  expect(set(1)).toHaveTextContent('Score 6–4 · Won · Set completed');
  expect(within(set(1)).getAllByRole('article')).toHaveLength(10);
  expect(set(2)).toHaveTextContent('Score 7–6 · Won · Set completed');
  const tie = within(set(2)).getByRole('region', { name: 'Standard tie-break' });
  expect(tie).toHaveTextContent('7–3'); expect(tie).toHaveTextContent('Won');
  expect(within(tie).getByTestId('metric-netErrors')).toHaveTextContent('1');
  expect(within(within(tie).getByTestId('metric-wideErrors')).getByLabelText('unknown')).toHaveTextContent('—');
  expect(screen.getByLabelText('Comments')).toHaveValue('Felt sharp');
});

it('shows unfinished sets and incomplete matches in text', async () => {
  show(await seeded(abandoned()), 'm2');
  expect(await screen.findByText('Abandoned (unfinished)')).toBeInTheDocument();
  expect(screen.getByText('No result, sets 0–0')).toBeInTheDocument();
  expect(set(1)).toHaveTextContent('Score 2–1 · No result · Set unfinished');
});

it('shows per-match averages with sample sizes, distinguishing unknown from explicit zero', async () => {
  show(await seeded(completed()));
  const averages = await screen.findByRole('region', { name: 'Match averages' });
  const row = (label: string) => within(averages).getByRole('row', { name: new RegExp(`^${label}`) });
  expect(within(averages).getAllByRole('row').slice(1)).toHaveLength(3);
  expect(row('Unforced errors')).toHaveTextContent('1'); expect(row('Unforced errors')).toHaveTextContent('2 games');
  expect(row('Double faults')).toHaveTextContent('0 service games'); expect(within(row('Double faults')).getByLabelText('unknown')).toHaveTextContent('—');
  expect(within(row('Receive errors')).getByLabelText('unknown')).toHaveTextContent('—'); expect(row('Receive errors')).toHaveTextContent('0 return games');
  for (const label of ['Net errors', 'Wide errors', 'Long errors', 'Failed returns']) expect(within(averages).queryByRole('row', { name: new RegExp(`^${label}`) })).not.toBeInTheDocument();
  expect(averages).not.toHaveTextContent(/total/i);
});

it('persists an edited comment without reactivating the match', async () => {
  const deps = await seeded(completed()); show(deps);
  fireEvent.change(await screen.findByLabelText('Comments'), { target: { value: 'Tired legs' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save comments' }));
  await waitFor(async () => expect((await stored(deps)).match.comments).toBe('Tired legs'));
  expect((await stored(deps)).match.status).toBe('completed');
  expect(await screen.findByRole('status')).toHaveTextContent('Comments saved');
});

it('recalculates the derived set score after a non-conflicting game edit', async () => {
  const deps = await seeded(abandoned()); show(deps, 'm2');
  await screen.findByText('Abandoned (unfinished)');
  fireEvent.click(within(set(1)).getByRole('button', { name: 'Edit game 2' }));
  fireEvent.change(screen.getByLabelText('Result'), { target: { value: 'won' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save game' }));
  await waitFor(() => expect(set(1)).toHaveTextContent('Score 3–0 · No result · Set unfinished'));
  expect(screen.queryByRole('region', { name: /affected records/i })).not.toBeInTheDocument();
  expect((await stored(deps, 'm2')).games.find(g => g.id === 'u1-g2')!.result).toBe('won');
  expect((await stored(deps, 'm2')).match.status).toBe('abandoned');
});

it('requires conflict confirmation before applying a disruptive game edit', async () => {
  const deps = await seeded(completed()); show(deps);
  await screen.findByText('Completed');
  fireEvent.click(within(set(1)).getByRole('button', { name: 'Edit game 1' }));
  fireEvent.change(screen.getByLabelText('Result'), { target: { value: 'lost' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save game' }));
  const confirm = await screen.findByRole('region', { name: /affected records/i });
  expect(confirm).toHaveTextContent('Set 1 outcome changes');
  expect((await stored(deps)).games[0].result).toBe('won');
  expect(set(1)).toHaveTextContent('Score 6–4 · Won');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel correction' }));
  expect((await stored(deps)).games[0].result).toBe('won');
  fireEvent.click(screen.getByRole('button', { name: 'Save game' }));
  await screen.findByRole('region', { name: /affected records/i });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm affected records' }));
  await waitFor(() => expect(set(1)).toHaveTextContent('Score 5–5 · No result · Recorded as completed — score no longer decides the set'));
  expect((await stored(deps)).games.find(g => g.id === 's1-g1')!.result).toBe('lost');
  expect((await stored(deps)).match.status).toBe('completed');
});

it('edits match metadata and a tie-break, re-deriving results', async () => {
  const deps = await seeded(completed()); show(deps);
  await screen.findByText('Completed');
  fireEvent.change(screen.getByLabelText('Opponent'), { target: { value: 'Casey' } });
  fireEvent.change(screen.getByLabelText('Date and time'), { target: { value: '2026-11-09T07:15' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save match details' }));
  expect(await screen.findByRole('heading', { level: 1, name: 'Match against Casey' })).toBeInTheDocument();
  expect(screen.getByText('9 Nov 2026, 07:15')).toBeInTheDocument();
  expect((await stored(deps)).match.playedAt).toBe(new Date(2026, 10, 9, 7, 15).toISOString());
  fireEvent.click(within(set(2)).getByRole('button', { name: 'Edit tie-break' }));
  expect(screen.getByLabelText('Player points')).toHaveValue(7);
  fireEvent.change(screen.getByLabelText('Player points'), { target: { value: '3' } });
  fireEvent.change(screen.getByLabelText('Opponent points'), { target: { value: '7' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save tie-break' }));
  expect(await screen.findByRole('region', { name: /affected records/i })).toHaveTextContent('Set 2 outcome changes');
  fireEvent.click(screen.getByRole('button', { name: 'Confirm affected records' }));
  await waitFor(() => expect(set(2)).toHaveTextContent('Score 6–7 · Lost · Set completed'));
  expect(screen.getByText('No result, sets 1–1')).toBeInTheDocument();
  expect((await stored(deps)).tieBreaks[0].opponentPoints).toBe(7);
});

it('never returns a completed match to active and does not block a new match', async () => {
  const deps = await seeded(completed()); show(deps);
  await screen.findByText('Completed');
  const status = async () => { const bundle = await stored(deps); expect(bundle.match.status).toBe('completed'); expect(await deps.repository.getActiveMatch()).toBeUndefined(); };
  const save = vi.spyOn(deps.repository, 'saveMatchBundle');
  const saved = (count: number) => waitFor(() => expect(save).toHaveBeenCalledTimes(count));
  // comment
  fireEvent.change(screen.getByLabelText('Comments'), { target: { value: 'x' } }); fireEvent.click(screen.getByRole('button', { name: 'Save comments' }));
  await saved(1); await status();
  // metadata, including a format change that needs confirmation
  fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'openPractice' } }); fireEvent.click(screen.getByRole('button', { name: 'Save match details' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm affected records' }));
  await saved(2); await status(); expect(await screen.findByText('Open/practice match', { selector: 'dd' })).toBeInTheDocument();
  // game edit with conflict confirmation
  fireEvent.click(within(set(1)).getByRole('button', { name: 'Edit game 1' }));
  fireEvent.change(screen.getByLabelText('Result'), { target: { value: 'lost' } }); fireEvent.click(screen.getByRole('button', { name: 'Save game' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm affected records' }));
  await saved(3); await status();
  // game delete
  fireEvent.click(within(set(1)).getByRole('button', { name: 'Delete game 10' }));
  // removing the last set-1 game shifts every later expected server, so it needs confirmation too
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm affected records' }));
  await saved(4); await status();
  // tie-break edit
  fireEvent.click(within(set(2)).getByRole('button', { name: 'Edit tie-break' }));
  fireEvent.change(screen.getByLabelText('Player points'), { target: { value: '8' } }); fireEvent.change(screen.getByLabelText('Opponent points'), { target: { value: '6' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save tie-break' }));
  await saved(5); await status();
  expect(screen.getByText('Completed')).toBeInTheDocument();
  await expect(startMatch({ opponentName: 'Dana', playedAt: '2026-11-12T12:00:00.000Z', firstServer: 'player' }, deps)).resolves.toBeDefined();
});

it('shows a clear not-found state with a link to the history', async () => {
  show(await seeded(completed()), 'nope');
  expect(await screen.findByRole('heading', { name: 'Match not found' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /back to matches/i })).toHaveAttribute('href', '/matches');
});

it('offers Retry when loading fails', async () => {
  const deps = await seeded(completed());
  const real = deps.repository.getMatchBundle.bind(deps.repository);
  const get = vi.spyOn(deps.repository, 'getMatchBundle').mockRejectedValueOnce(new Error('offline')).mockImplementation(real);
  show(deps);
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load match');
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByRole('heading', { level: 1, name: 'Match against Alex' })).toBeInTheDocument();
  expect(get).toHaveBeenCalledTimes(2);
});

it('closes an owned repository on unmount but not an injected one', async () => {
  const deps = await seeded(completed());
  const close = vi.spyOn(deps.repository, 'close');
  const injected = show(deps); await screen.findByText('Completed'); injected.unmount();
  expect(close).not.toHaveBeenCalled();
  const owned = { getMatchBundle: vi.fn(async () => completed()), close: vi.fn(), getRecoveryStatus: () => ({ mode: 'normal' as const }) } as unknown as TennisRepository;
  mocks.openDatabase.mockResolvedValue(owned);
  const view = show(undefined); await screen.findByText('Completed'); view.unmount();
  expect(owned.close).toHaveBeenCalledTimes(1);
});

it('saves only changed metadata, leaving a precise playedAt byte-identical', async () => {
  const precise = completed(); precise.match.playedAt = '2026-11-10T18:30:42.123Z';
  const deps = await seeded(precise); show(deps);
  await screen.findByText('Completed');
  fireEvent.change(screen.getByLabelText('Opponent'), { target: { value: 'Casey' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save match details' }));
  expect(await screen.findByRole('heading', { level: 1, name: 'Match against Casey' })).toBeInTheDocument();
  const after = await stored(deps);
  expect(after.match.playedAt).toBe('2026-11-10T18:30:42.123Z'); expect(after.match.format).toBe('bestOfThree');
});

it('keeps 44px targets on the error, not-found and loaded states', async () => {
  const style = document.createElement('style'); style.textContent = readFileSync(resolve(process.cwd(), 'src/styles/global.css'), 'utf8'); document.head.append(style);
  try {
    const big = (element: HTMLElement) => { expect(parseFloat(getComputedStyle(element).minHeight)).toBeGreaterThanOrEqual(44); expect(parseFloat(getComputedStyle(element).minWidth)).toBeGreaterThanOrEqual(44); };
    const deps = await seeded(completed());
    const real = deps.repository.getMatchBundle.bind(deps.repository);
    vi.spyOn(deps.repository, 'getMatchBundle').mockRejectedValueOnce(new Error('offline')).mockImplementation(real);
    const failing = show(deps);
    await screen.findByRole('alert');
    big(screen.getByRole('button', { name: 'Retry' })); big(screen.getByRole('link', { name: 'Back to matches' }));
    failing.unmount();
    const missing = show(deps, 'nope');
    await screen.findByRole('heading', { name: 'Match not found' });
    big(screen.getByRole('link', { name: 'Back to matches' }));
    missing.unmount();
    show(deps); await screen.findByText('Completed');
    big(screen.getByRole('link', { name: 'Back to matches' })); big(screen.getByRole('button', { name: 'Save comments' })); big(within(set(1)).getByRole('button', { name: 'Edit game 1' }));
  } finally { style.remove(); }
});

it('in read-only recovery mode keeps the match viewable but disables every correction with a notice', async () => {
  const name = `details-recovery-${crypto.randomUUID()}`;
  const seededRepo = await openDatabase(name); await seededRepo.saveMatchBundle(completed()); seededRepo.close();
  const repository = await openDatabase(name, async () => { throw new Error('migration failed'); }); repos.push(repository);
  const save = vi.spyOn(repository, 'saveMatchBundle');
  show({ repository, clock: { now: () => '2026-11-12T12:00:00.000Z' }, ids: { next: () => 'x' } });
  expect(await screen.findByRole('heading', { name: 'Match against Alex' })).toBeInTheDocument();
  expect(screen.getByRole('note')).toHaveTextContent(/read-only recovery mode: correcting games, tie-breaks, match details and comments is turned off/i);
  const controls = [screen.getByRole('button', { name: 'Save comments' }), screen.getByRole('button', { name: 'Save match details' }), screen.getByRole('button', { name: 'Edit tie-break' }), ...screen.getAllByRole('button', { name: /^(Edit|Delete) game \d+$/ })];
  expect(controls.length).toBeGreaterThan(4);
  for (const control of controls) { expect(control).toBeDisabled(); fireEvent.click(control); }
  expect(save).not.toHaveBeenCalled();
});

function diagRow(id: string, startedAt: string): MatchDiagnostic {
  return { id, matchId: 'm1', setId: null, draftId: null, phase: 'parser', attempt: 1, provider: 'p', model: 'mod', startedAt, finishedAt: startedAt, outcome: 'success', transcript: null, request: null, response: null, error: null };
}
const fakeTransfer = (download = vi.fn()): FileTransfer => ({ download, readText: vi.fn() });

it('hides voice diagnostics when the match has no rows', async () => {
  const deps = await seeded(completed());
  show(deps, 'm1', fakeTransfer()); await screen.findByText('Completed');
  expect(screen.queryByRole('button', { name: 'Download voice diagnostics' })).not.toBeInTheDocument();
  expect(screen.queryByText(/Voice diagnostics:/)).not.toBeInTheDocument();
});

it('downloads saved voice diagnostics', async () => {
  const deps = await seeded(completed());
  await deps.repository.saveDiagnostic(diagRow('d2', '2026-11-10T10:00:02.000Z')); await deps.repository.saveDiagnostic(diagRow('d1', '2026-11-10T10:00:01.000Z'));
  const download = vi.fn(); show(deps, 'm1', fakeTransfer(download));
  expect(await screen.findByText('Voice diagnostics: 2 events')).toBeInTheDocument();
  const button = screen.getByRole('button', { name: 'Download voice diagnostics' });
  fireEvent.click(button);
  await screen.findByText('Voice diagnostics downloaded.');
  expect(download).toHaveBeenCalledTimes(1);
  const [name, text] = download.mock.calls[0];
  expect(name).toBe('tennis-stats-voice-diagnostics-m1-2026-11-12.json');
  expect(JSON.parse(text).diagnostics.map((r: { id: string }) => r.id)).toEqual(['d1', 'd2']);
});

it('downloads voice diagnostics in read-only recovery mode', async () => {
  const name = `details-diag-recovery-${crypto.randomUUID()}`;
  const seededRepo = await openDatabase(name); await seededRepo.saveMatchBundle(completed()); await seededRepo.saveDiagnostic(diagRow('d1', '2026-11-10T10:00:01.000Z')); seededRepo.close();
  const repository = await openDatabase(name, async () => { throw new Error('migration failed'); }); repos.push(repository);
  const download = vi.fn();
  show({ repository, clock: { now: () => '2026-11-12T12:00:00.000Z' }, ids: { next: () => 'x' } }, 'm1', fakeTransfer(download));
  const button = await screen.findByRole('button', { name: 'Download voice diagnostics' });
  expect(button).toBeEnabled(); fireEvent.click(button);
  await screen.findByText('Voice diagnostics downloaded.');
  expect(download).toHaveBeenCalledTimes(1);
});

it('shows an alert when the diagnostics download fails and stays usable', async () => {
  const deps = await seeded(completed());
  await deps.repository.saveDiagnostic(diagRow('d1', '2026-11-10T10:00:01.000Z'));
  show(deps, 'm1', fakeTransfer(vi.fn(() => { throw new FileTransferError('The browser blocked the download.'); })));
  fireEvent.click(await screen.findByRole('button', { name: 'Download voice diagnostics' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('The browser blocked the download.');
  expect(screen.getByRole('button', { name: 'Download voice diagnostics' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Save comments' })).toBeEnabled();
});

it('treats a diagnostics count failure as zero', async () => {
  const deps = await seeded(completed());
  vi.spyOn(deps.repository, 'countDiagnostics').mockRejectedValue(new Error('boom'));
  show(deps, 'm1', fakeTransfer()); await screen.findByText('Completed');
  expect(screen.queryByRole('button', { name: 'Download voice diagnostics' })).not.toBeInTheDocument();
});
