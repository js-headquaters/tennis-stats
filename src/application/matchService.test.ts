import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../infrastructure/db/database';
import { abandonActiveMatch, addGames, completeTieBreak, deleteGame, endSetEarly, finishMatch, prepareGames, startMatch, updateComments, updateGame, updateMatchDetails, updateTieBreak } from './matchService';

const clock = { now: () => '2026-01-01T12:00:00.000Z' };
let counter = 0;
const ids = { next: () => `id-${++counter}` };
const repos: Awaited<ReturnType<typeof openDatabase>>[] = [];
afterEach(() => { repos.forEach(repo => repo.close()); repos.length = 0; });
async function setup() { const repository = await openDatabase(`service-${++counter}`); repos.push(repository); return { repository, clock, ids }; }
const input = { opponentName: ' Alex ', playedAt: clock.now(), firstServer: 'player' as const };

describe('match services', () => {
  it('prepares games without saving or mutating the original bundle', async () => {
    const deps = await setup(); const initial = await startMatch(input, deps);
    const snapshot = structuredClone(initial);
    const save = vi.spyOn(deps.repository, 'saveMatchBundle');
    const game = { result: 'won' as const, netErrors: null, wideErrors: null, longErrors: null, doubleFaults: null, failedReturns: null };
    const prepared = prepareGames(initial, [game, game], deps);
    expect(initial).toEqual(snapshot);
    expect(save).not.toHaveBeenCalled();
    expect(prepared.games.map(item => [item.ordinal, item.server])).toEqual([[1, 'player'], [2, 'opponent']]);
  });
  it.each(['bestOfThree', 'openPractice'] as const)('continues %s with a standard set after an early end', async format => {
    const deps = await setup(); const initial = await startMatch({ ...input, format }, deps);
    const result = await endSetEarly(initial.sets[0].id, deps);
    expect(result.sets.map(set => [set.kind, set.status])).toEqual([['standard', 'unfinished'], ['standard', 'active']]);
    expect(result.match.status).toBe('active');
  });
  it('creates a deciding super set after split completed sets following an unfinished set', async () => {
    const deps = await setup(); const initial = await startMatch(input, deps);
    await endSetEarly(initial.sets[0].id, deps);
    const metrics = { netErrors: null, wideErrors: null, longErrors: null, doubleFaults: null, failedReturns: null };
    const result = await addGames(initial.match.id, [...Array.from({ length: 6 }, () => ({ ...metrics, result: 'won' as const })), ...Array.from({ length: 6 }, () => ({ ...metrics, result: 'lost' as const }))], deps);
    expect(result.sets.map(s => [s.kind, s.status])).toEqual([['standard', 'unfinished'], ['standard', 'completed'], ['standard', 'completed'], ['decidingSuperTiebreak', 'active']]);
  });
  it('rejects invalid tie-break points and metrics without saving', async () => {
    const deps = await setup(); const initial = await startMatch({ ...input, format: 'oneSet' }, deps);
    const metrics = { netErrors: null, wideErrors: null, longErrors: null, doubleFaults: null, failedReturns: null };
    await addGames(initial.match.id, Array.from({ length: 12 }, (_, i) => ({ ...metrics, result: i % 2 ? 'lost' as const : 'won' as const })), deps);
    const save = vi.spyOn(deps.repository, 'saveMatchBundle');
    const tie = { setId: initial.sets[0].id, kind: 'standard' as const, playerPoints: 7, opponentPoints: 5, ...metrics };
    for (const patch of [{ playerPoints: -1 }, { opponentPoints: -1 }, { playerPoints: 7.5 }, { opponentPoints: 0.5 }, { playerPoints: 6 }, { netErrors: -1 }, { wideErrors: 0.5 }, { longErrors: -1 }, { doubleFaults: 0.5 }, { kind: 'super' as const }, { kind: 'invalid' as 'standard' }]) {
      await expect(completeTieBreak({ ...tie, ...patch }, deps)).rejects.toThrow();
    }
    expect(save).not.toHaveBeenCalled();
    await completeTieBreak(tie, deps);
    expect(save).toHaveBeenCalledTimes(1);
    await expect(completeTieBreak(tie, deps)).rejects.toThrow();
    expect(save).toHaveBeenCalledTimes(1);
  });
  it('rejects a tie-break when the active set belongs to a different match', async () => {
    const deps = await setup(); const initial = await startMatch(input, deps);
    const metrics = { netErrors: null, wideErrors: null, longErrors: null, doubleFaults: null, failedReturns: null };
    const altered = await addGames(initial.match.id, Array.from({ length: 12 }, (_, i) => ({ ...metrics, result: i % 2 ? 'lost' as const : 'won' as const })), deps);
    altered.sets[0].matchId = 'other-match';
    vi.spyOn(deps.repository, 'getMatchBundle').mockResolvedValue(altered);
    const save = vi.spyOn(deps.repository, 'saveMatchBundle');
    await expect(completeTieBreak({ setId: initial.sets[0].id, kind: 'standard', playerPoints: 7, opponentPoints: 5, netErrors: null, wideErrors: null, longErrors: null, doubleFaults: null }, deps)).rejects.toThrow(/match|own/i);
    expect(save).not.toHaveBeenCalled();
  });
  it('rejects missing state and invalid batches without saving', async () => {
    const deps = await setup(); const initial = await startMatch(input, deps);
    const save = vi.spyOn(deps.repository, 'saveMatchBundle');
    await expect(addGames('missing', [], deps)).rejects.toThrow();
    await expect(addGames(initial.match.id, [], deps)).rejects.toThrow();
    await expect(endSetEarly('missing', deps)).rejects.toThrow();
    await expect(finishMatch('missing', deps)).rejects.toThrow();
    await expect(updateGame('missing', {}, deps)).rejects.toThrow();
    await expect(deleteGame('missing', deps)).rejects.toThrow();
    const game = { result: 'won' as const, netErrors: null, wideErrors: null, longErrors: null, doubleFaults: null, failedReturns: null };
    await expect(addGames(initial.match.id, [game, { ...game, netErrors: -1 }], deps)).rejects.toThrow();
    await expect(completeTieBreak({ setId: initial.sets[0].id, kind: 'standard', playerPoints: 7, opponentPoints: 5, netErrors: null, wideErrors: null, longErrors: null, doubleFaults: null }, deps)).rejects.toThrow();
    await expect(completeTieBreak({ setId: 'missing', kind: 'standard', playerPoints: 7, opponentPoints: 5, netErrors: null, wideErrors: null, longErrors: null, doubleFaults: null }, deps)).rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
  });
  it('does not mutate a fetched reference while completing a tie-break', async () => {
    const deps = await setup(); const initial = await startMatch({ ...input, format: 'oneSet' }, deps);
    const metrics = { netErrors: null, wideErrors: null, longErrors: null, doubleFaults: null, failedReturns: null };
    const reference = await addGames(initial.match.id, Array.from({ length: 12 }, (_, i) => ({ ...metrics, result: i % 2 ? 'lost' as const : 'won' as const })), deps);
    const snapshot = structuredClone(reference);
    vi.spyOn(deps.repository, 'getMatchBundle').mockResolvedValue(reference);
    const save = vi.spyOn(deps.repository, 'saveMatchBundle').mockImplementation(async () => { expect(reference).toEqual(snapshot); });
    await completeTieBreak({ setId: initial.sets[0].id, kind: 'standard', playerPoints: 7, opponentPoints: 5, ...metrics }, deps);
    expect(save).toHaveBeenCalledTimes(1);
    expect(reference).toEqual(snapshot);
  });
  it('does not mutate a fetched reference before a successful save', async () => {
    const deps = await setup(); const initial = await startMatch(input, deps);
    const reference = structuredClone(initial); const snapshot = structuredClone(reference);
    vi.spyOn(deps.repository, 'getMatchBundle').mockResolvedValue(reference);
    const save = vi.spyOn(deps.repository, 'saveMatchBundle').mockImplementation(async () => { expect(reference).toEqual(snapshot); });
    await addGames(initial.match.id, [{ result: 'won', netErrors: null, wideErrors: null, longErrors: null, doubleFaults: null, failedReturns: null }], deps);
    expect(save).toHaveBeenCalledTimes(1);
    expect(reference).toEqual(snapshot);
  });
  it('keeps fetched references intact for corrections, early end, finish and comments', async () => {
    const deps = await setup(); const initial = await startMatch(input, deps);
    let reference = await addGames(initial.match.id, [{ result: 'won', netErrors: null, wideErrors: null, longErrors: null, doubleFaults: null, failedReturns: null }], deps);
    vi.spyOn(deps.repository, 'getMatchBundle').mockImplementation(async () => reference);
    let snapshot = structuredClone(reference); let calls = 0;
    vi.spyOn(deps.repository, 'saveMatchBundle').mockImplementation(async bundle => {
      expect(reference).toEqual(snapshot);
      reference = bundle; calls++;
    });
    await updateGame(reference.games[0].id, { netErrors: 0 }, deps); expect(calls).toBe(1);
    snapshot = structuredClone(reference);
    await deleteGame(reference.games[0].id, deps); expect(calls).toBe(2);
    snapshot = structuredClone(reference);
    await endSetEarly(reference.sets[0].id, deps); expect(calls).toBe(3);
    snapshot = structuredClone(reference);
    await finishMatch(reference.match.id, deps); expect(calls).toBe(4);
    snapshot = structuredClone(reference);
    await updateComments(reference.match.id, 'notes', deps); expect(calls).toBe(5);
  });
  it('rejects invalid game patches without saving', async () => {
    const deps = await setup(); const initial = await startMatch(input, deps);
    const added = await addGames(initial.match.id, [{ result: 'won', netErrors: null, wideErrors: null, longErrors: null, doubleFaults: null, failedReturns: null }], deps);
    const save = vi.spyOn(deps.repository, 'saveMatchBundle');
    for (const patch of [{ netErrors: -1 }, { wideErrors: 0.5 }, { result: 'draw' }, { server: 'nobody' }, { score: { player: '2', opponent: '0' } }, { ordinal: 7 }]) {
      await expect(updateGame(added.games[0].id, patch as never, deps)).rejects.toThrow();
    }
    expect(save).not.toHaveBeenCalled();
  });
  it('saves correction previews zero times and confirmations once while retaining later servers', async () => {
    const deps = await setup(); const initial = await startMatch(input, deps);
    const game = { result: 'won' as const, netErrors: null, wideErrors: null, longErrors: null, doubleFaults: null, failedReturns: null };
    const added = await addGames(initial.match.id, [game, { ...game, server: 'player' }, { ...game, server: 'opponent' }], deps);
    const save = vi.spyOn(deps.repository, 'saveMatchBundle');
    const preview = await deleteGame(added.games[0].id, deps);
    expect(preview.conflicts.filter(c => c.type === 'serverChanged').map(c => c.gameId)).toEqual(expect.arrayContaining([added.games[1].id, added.games[2].id]));
    expect(save).not.toHaveBeenCalled();
    const confirmed = await deleteGame(added.games[0].id, deps, true);
    expect(save).toHaveBeenCalledTimes(1);
    expect(confirmed.bundle.games.map(g => g.server)).toEqual(['player', 'opponent']);
  });
  it('detects invalidated tie-break, completed set and match outcome in a correction preview', async () => {
    const deps = await setup(); const initial = await startMatch({ ...input, format: 'oneSet' }, deps);
    const metrics = { netErrors: null, wideErrors: null, longErrors: null, doubleFaults: null, failedReturns: null };
    await addGames(initial.match.id, Array.from({ length: 12 }, (_, i) => ({ ...metrics, result: i % 2 ? 'lost' as const : 'won' as const })), deps);
    const completed = await completeTieBreak({ setId: initial.sets[0].id, kind: 'standard', playerPoints: 7, opponentPoints: 5, ...metrics }, deps);
    const save = vi.spyOn(deps.repository, 'saveMatchBundle');
    const preview = await updateGame(completed.games[0].id, { result: 'lost' }, deps);
    expect(preview.conflicts.map(c => c.type)).toEqual(expect.arrayContaining(['structureInvalidated', 'setOutcomeInvalidated', 'matchOutcomeInvalidated']));
    expect(save).not.toHaveBeenCalled();
    const confirmed = await updateGame(completed.games[0].id, { result: 'lost' }, deps, true);
    expect(save).toHaveBeenCalledTimes(1);
    expect(confirmed.bundle.games.slice(1).map(g => g.server)).toEqual(completed.games.slice(1).map(g => g.server));
    expect(confirmed.bundle.tieBreaks).toEqual(completed.tieBreaks);
  });
  describe('corrections that complete the active set', () => {
    const metrics = { netErrors: null, wideErrors: null, longErrors: null, doubleFaults: null, failedReturns: null };
    const alternate = (n: number) => Array.from({ length: n }, (_, i) => ({ ...metrics, result: i % 2 ? 'lost' as const : 'won' as const }));
    it('previews, then finalises the set and creates the next set exactly like addGames', async () => {
      const deps = await setup(); const initial = await startMatch(input, deps);
      const added = await addGames(initial.match.id, alternate(10), deps);
      expect(added.sets.map(s => s.status)).toEqual(['active']);
      const save = vi.spyOn(deps.repository, 'saveMatchBundle');
      const preview = await updateGame(added.games[1].id, { result: 'won' }, deps);
      expect(preview.conflicts.length).toBeGreaterThan(0);
      expect(save).not.toHaveBeenCalled();
      expect(preview.bundle.sets.map(s => s.status)).toEqual(['active']);
      const confirmed = await updateGame(added.games[1].id, { result: 'won' }, deps, true);
      expect(save).toHaveBeenCalledTimes(1);
      expect(confirmed.bundle.sets.map(s => [s.ordinal, s.kind, s.status])).toEqual([[1, 'standard', 'completed'], [2, 'standard', 'active']]);
      expect(confirmed.bundle.match.status).toBe('active');
      expect(await deps.repository.getMatchBundle(initial.match.id)).toEqual(confirmed.bundle);
    });
    it('completes the match when the format says so, and also via deleteGame', async () => {
      const deps = await setup(); const initial = await startMatch({ ...input, format: 'oneSet' }, deps);
      const added = await addGames(initial.match.id, [...Array.from({ length: 5 }, () => ({ ...metrics, result: 'won' as const })), ...Array.from({ length: 5 }, () => ({ ...metrics, result: 'lost' as const })), { ...metrics, result: 'won' as const }], deps);
      expect(added.sets[0].status).toBe('active');
      const confirmed = await deleteGame(added.games[5].id, deps, true);
      expect(confirmed.bundle.sets.map(s => s.status)).toEqual(['completed']);
      expect(confirmed.bundle.match.status).toBe('completed');
      expect(await deps.repository.getActiveMatch()).toBeUndefined();
    });
    it('creates a deciding super tie-break set when sets split', async () => {
      const deps = await setup(); const initial = await startMatch(input, deps);
      await addGames(initial.match.id, Array.from({ length: 6 }, () => ({ ...metrics, result: 'won' as const })), deps);
      const added = await addGames(initial.match.id, [...Array.from({ length: 5 }, () => ({ ...metrics, result: 'lost' as const })), ...Array.from({ length: 4 }, () => ({ ...metrics, result: 'won' as const }))], deps);
      const confirmed = await updateGame(added.games[6 + 5].id, { result: 'lost' }, deps, true);
      expect(confirmed.bundle.sets.map(s => [s.kind, s.status])).toEqual([['standard', 'completed'], ['standard', 'completed'], ['decidingSuperTiebreak', 'active']]);
    });
    it('never reactivates or adds sets to a finished match', async () => {
      const deps = await setup(); const initial = await startMatch({ ...input, format: 'oneSet' }, deps);
      const added = await addGames(initial.match.id, [...Array.from({ length: 6 }, () => ({ ...metrics, result: 'won' as const }))], deps);
      expect(added.match.status).toBe('completed');
      const edited = await updateGame(added.games[0].id, { netErrors: 1 }, deps);
      expect(edited.bundle.match.status).toBe('completed');
      const after = await deps.repository.getMatchBundle(initial.match.id);
      expect(after!.sets).toHaveLength(1);
      expect(after!.match.status).toBe('completed');
    });
  });
  it('rejects a mismatched tie-break reference without saving', async () => {
    const deps = await setup(); const initial = await startMatch(input, deps);
    const altered = structuredClone(initial); altered.sets[0].tieBreakId = 'other-tie';
    vi.spyOn(deps.repository, 'getMatchBundle').mockResolvedValue(altered);
    const save = vi.spyOn(deps.repository, 'saveMatchBundle');
    await expect(completeTieBreak({ setId: initial.sets[0].id, kind: 'standard', playerPoints: 7, opponentPoints: 5, netErrors: null, wideErrors: null, longErrors: null, doubleFaults: null }, deps)).rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
  });
  it('never reactivates a finished match and preserves unrelated records on comments and finish', async () => {
    const deps = await setup(); const initial = await startMatch(input, deps);
    const added = await addGames(initial.match.id, [{ result: 'won', netErrors: null, wideErrors: null, longErrors: null, doubleFaults: null, failedReturns: null }], deps);
    const save = vi.spyOn(deps.repository, 'saveMatchBundle');
    const finished = await finishMatch(initial.match.id, deps);
    expect(save).toHaveBeenCalledTimes(1);
    expect(finished.games).toEqual(added.games);
    expect(finished.sets[0].status).toBe('unfinished');
    const commented = await updateComments(initial.match.id, 'note', deps);
    expect(save).toHaveBeenCalledTimes(2);
    expect(commented.match.status).toBe('completed');
    expect(commented.games).toEqual(added.games);
    expect(commented.sets).toEqual(finished.sets);
    await expect(finishMatch(initial.match.id, deps)).rejects.toThrow();
    await expect(endSetEarly(initial.sets[0].id, deps)).rejects.toThrow();
    await expect(addGames(initial.match.id, [{ result: 'won', netErrors: null, wideErrors: null, longErrors: null, doubleFaults: null, failedReturns: null }], deps)).rejects.toThrow();
    expect(save).toHaveBeenCalledTimes(2);
  });
  it('saves a non-disruptive update once and previews a server update without a save', async () => {
    const deps = await setup(); const initial = await startMatch(input, deps);
    const game = { result: 'won' as const, netErrors: null, wideErrors: null, longErrors: null, doubleFaults: null, failedReturns: null };
    const added = await addGames(initial.match.id, [game, game], deps);
    const save = vi.spyOn(deps.repository, 'saveMatchBundle');
    expect((await updateGame(added.games[0].id, { netErrors: 0 }, deps)).conflicts).toEqual([]);
    expect(save).toHaveBeenCalledTimes(1);
    const preview = await updateGame(added.games[0].id, { server: 'opponent' }, deps);
    expect(preview.conflicts.some(c => c.type === 'serverChanged' && c.gameId === added.games[1].id)).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    const confirmed = await updateGame(added.games[0].id, { server: 'opponent' }, deps, true);
    expect(save).toHaveBeenCalledTimes(2);
    expect(confirmed.bundle.games[1].server).toBe(added.games[1].server);
  });
  it('does not create a continuation when a one-set match is ended early', async () => {
    const deps = await setup(); const initial = await startMatch({ ...input, format: 'oneSet' }, deps);
    const ended = await endSetEarly(initial.sets[0].id, deps);
    expect(ended.match.status).toBe('active');
    expect(ended.sets.map(set => set.status)).toEqual(['unfinished']);
    const finished = await finishMatch(initial.match.id, deps);
    expect(finished.match.status).toBe('completed');
    expect(finished.sets.map(set => set.status)).toEqual(['unfinished']);
  });
  it('persists batch games with alternating servers and preserves zero and unknown metrics', async () => {
    const deps = await setup(); const initial = await startMatch(input, deps);
    const metrics = { netErrors: 0, wideErrors: null, longErrors: null, doubleFaults: null, failedReturns: null };
    await addGames(initial.match.id, [{ ...metrics, result: 'won' }, { ...metrics, result: 'lost' }], deps);
    const saved = await deps.repository.getMatchBundle(initial.match.id);
    expect(saved?.games.map(game => [game.server, game.result, game.netErrors, game.wideErrors])).toEqual([
      ['player', 'won', 0, null], ['opponent', 'lost', 0, null],
    ]);
  });
  it('rejects an invalid game in a batch without saving earlier games', async () => {
    const deps = await setup(); const initial = await startMatch(input, deps);
    const metrics = { netErrors: null, wideErrors: null, longErrors: null, doubleFaults: null, failedReturns: null };
    await expect(addGames(initial.match.id, [{ ...metrics, result: 'won' }, { ...metrics, result: 'lost', doubleFaults: 0 }], deps)).rejects.toThrow(/doubleFaults/i);
    expect(await deps.repository.getMatchBundle(initial.match.id)).toEqual(initial);
  });
  it('completes a one-set match when the sixth winning game is added', async () => {
    const deps = await setup(); const initial = await startMatch({ ...input, format: 'oneSet' }, deps);
    const game = { result: 'won' as const, netErrors: null, wideErrors: null, longErrors: null, doubleFaults: null, failedReturns: null };
    await addGames(initial.match.id, Array.from({ length: 6 }, () => game), deps);
    const saved = await deps.repository.getMatchBundle(initial.match.id);
    expect(saved?.match.status).toBe('completed');
    expect(saved?.sets.map(set => set.status)).toEqual(['completed']);
  });
  it('completes a standard tie-break at six games all', async () => {
    const deps = await setup(); const initial = await startMatch({ ...input, format: 'oneSet' }, deps);
    const metrics = { netErrors: null, wideErrors: null, longErrors: null, doubleFaults: null, failedReturns: null };
    await addGames(initial.match.id, Array.from({ length: 12 }, (_, i) => ({ ...metrics, result: i % 2 ? 'lost' as const : 'won' as const })), deps);
    await completeTieBreak({ setId: initial.sets[0].id, kind: 'standard', playerPoints: 7, opponentPoints: 5, ...metrics }, deps);
    expect((await deps.repository.getMatchBundle(initial.match.id))?.match.status).toBe('completed');
  });
  it('ends a set unfinished and explicitly finishes a practice match', async () => {
    const deps = await setup(); const initial = await startMatch({ ...input, format: 'openPractice' }, deps);
    await endSetEarly(initial.sets[0].id, deps);
    let saved = await deps.repository.getMatchBundle(initial.match.id);
    expect(saved?.sets.map(set => set.status)).toEqual(['unfinished', 'active']);
    await finishMatch(initial.match.id, deps);
    await updateComments(initial.match.id, 'notes', deps);
    saved = await deps.repository.getMatchBundle(initial.match.id);
    expect(saved?.match).toMatchObject({ status: 'completed', comments: 'notes' });
  });
  it('previews a disruptive deletion without writing and confirms without rewriting later servers', async () => {
    const deps = await setup(); const initial = await startMatch(input, deps);
    const game = { result: 'won' as const, netErrors: null, wideErrors: null, longErrors: null, doubleFaults: null, failedReturns: null };
    const added = await addGames(initial.match.id, [game, game], deps);
    const preview = await deleteGame(added.games[0].id, deps);
    expect(preview.conflicts.length).toBeGreaterThan(0);
    expect((await deps.repository.getMatchBundle(initial.match.id))?.games).toEqual(added.games);
    await deleteGame(added.games[0].id, deps, true);
    expect((await deps.repository.getMatchBundle(initial.match.id))?.games[0].server).toBe('opponent');
  });
  it('persists a non-disruptive correction', async () => {
    const deps = await setup(); const initial = await startMatch(input, deps);
    const added = await addGames(initial.match.id, [{ result: 'won', netErrors: null, wideErrors: null, longErrors: null, doubleFaults: null, failedReturns: null }], deps);
    const result = await updateGame(added.games[0].id, { netErrors: 0 }, deps);
    expect(result.conflicts).toEqual([]);
    expect((await deps.repository.getMatchBundle(initial.match.id))?.games[0].netErrors).toBe(0);
  });
  it('previews an outcome-changing correction and preserves the completed match until confirmation', async () => {
    const deps = await setup(); const initial = await startMatch({ ...input, format: 'oneSet' }, deps);
    const game = { result: 'won' as const, netErrors: null, wideErrors: null, longErrors: null, doubleFaults: null, failedReturns: null };
    const added = await addGames(initial.match.id, Array.from({ length: 6 }, () => game), deps);
    const preview = await updateGame(added.games[0].id, { result: 'lost' }, deps);
    expect(preview.conflicts.length).toBeGreaterThan(0);
    expect(await deps.repository.getMatchBundle(initial.match.id)).toEqual(added);
    await updateGame(added.games[0].id, { result: 'lost' }, deps, true);
    expect((await deps.repository.getMatchBundle(initial.match.id))?.games[0].result).toBe('lost');
  });
  it('rejects invalid correction metrics without writing', async () => {
    const deps = await setup(); const initial = await startMatch(input, deps);
    const added = await addGames(initial.match.id, [{ result: 'won', netErrors: null, wideErrors: null, longErrors: null, doubleFaults: null, failedReturns: null }], deps);
    await expect(updateGame(added.games[0].id, { failedReturns: 0 }, deps)).rejects.toThrow(/failedReturns/);
    expect(await deps.repository.getMatchBundle(initial.match.id)).toEqual(added);
  });
  it('continues towards two completed standard sets after an unfinished set', async () => {
    const deps = await setup(); const initial = await startMatch(input, deps);
    const game = { result: 'won' as const, netErrors: null, wideErrors: null, longErrors: null, doubleFaults: null, failedReturns: null };
    await endSetEarly(initial.sets[0].id, deps);
    const saved = await addGames(initial.match.id, Array.from({ length: 12 }, () => game), deps);
    expect(saved.match.status).toBe('completed');
    expect(saved.sets.map(s => s.status)).toEqual(['unfinished', 'completed', 'completed']);
  });
  it('replaces an interrupted deciding super set with another deciding super set', async () => {
    const deps = await setup(); const initial = await startMatch(input, deps);
    const metrics = { netErrors: null, wideErrors: null, longErrors: null, doubleFaults: null, failedReturns: null };
    const saved = await addGames(initial.match.id, [...Array.from({ length: 6 }, () => ({ ...metrics, result: 'won' as const })), ...Array.from({ length: 6 }, () => ({ ...metrics, result: 'lost' as const }))], deps);
    const result = await endSetEarly(saved.sets[2].id, deps);
    expect(result.sets[3]).toMatchObject({ kind: 'decidingSuperTiebreak', status: 'active' });
    const finished = await completeTieBreak({ setId: result.sets[3].id, kind: 'super', playerPoints: 10, opponentPoints: 8, ...metrics }, deps);
    expect(finished.match.status).toBe('completed');
    expect(finished.sets).toHaveLength(4);
  });
  it('detects invalidation of a completed set when later sets exist', async () => {
    const deps = await setup(); const initial = await startMatch(input, deps);
    const game = { result: 'won' as const, netErrors: null, wideErrors: null, longErrors: null, doubleFaults: null, failedReturns: null };
    const added = await addGames(initial.match.id, Array.from({ length: 7 }, () => game), deps);
    const save = vi.spyOn(deps.repository, 'saveMatchBundle');
    const preview = await deleteGame(added.games[0].id, deps);
    expect(preview.conflicts.map(c => c.type)).toContain('setOutcomeInvalidated');
    expect(save).not.toHaveBeenCalled();
    const confirmed = await deleteGame(added.games[0].id, deps, true);
    expect(save).toHaveBeenCalledTimes(1);
    expect(confirmed.bundle.sets).toEqual(added.sets);
    expect(confirmed.bundle.games.find(g => g.id === added.games[6].id)?.server).toBe(added.games[6].server);
  });
  it('completes a split match only after a valid deciding super tie-break', async () => {
    const deps = await setup(); const initial = await startMatch(input, deps);
    const metrics = { netErrors: null, wideErrors: null, longErrors: null, doubleFaults: null, failedReturns: null };
    const saved = await addGames(initial.match.id, [...Array.from({ length: 6 }, () => ({ ...metrics, result: 'won' as const })), ...Array.from({ length: 6 }, () => ({ ...metrics, result: 'lost' as const }))], deps);
    const tie = { setId: saved.sets[2].id, kind: 'super' as const, playerPoints: 11, opponentPoints: 8, ...metrics };
    await expect(completeTieBreak(tie, deps)).rejects.toThrow(/points/);
    expect(await deps.repository.getMatchBundle(initial.match.id)).toEqual(saved);
    const finished = await completeTieBreak({ ...tie, playerPoints: 10 }, deps);
    expect(finished.match.status).toBe('completed');
    expect(finished.sets).toHaveLength(3);
  });
  it('completes best of three after two standard set wins', async () => {
    const deps = await setup(); const initial = await startMatch({ ...input, format: 'bestOfThree' }, deps);
    const game = { result: 'won' as const, netErrors: null, wideErrors: null, longErrors: null, doubleFaults: null, failedReturns: null };
    const result = await addGames(initial.match.id, Array.from({ length: 12 }, () => game), deps);
    expect(result.match.status).toBe('completed');
    expect(result.sets.map(set => set.status)).toEqual(['completed', 'completed']);
  });
  it('previews a server correction that changes the expected next server', async () => {
    const deps = await setup(); const initial = await startMatch(input, deps);
    const game = { result: 'won' as const, netErrors: null, wideErrors: null, longErrors: null, doubleFaults: null, failedReturns: null };
    const added = await addGames(initial.match.id, [game, game], deps);
    const preview = await updateGame(added.games[0].id, { server: 'opponent' }, deps);
    expect(preview.conflicts.some(c => c.type === 'serverChanged')).toBe(true);
    expect(await deps.repository.getMatchBundle(initial.match.id)).toEqual(added);
  });
  it('infers the next server from the last explicitly recorded server', async () => {
    const deps = await setup(); const initial = await startMatch(input, deps);
    const game = { result: 'won' as const, netErrors: null, wideErrors: null, longErrors: null, doubleFaults: null, failedReturns: null };
    const result = await addGames(initial.match.id, [{ ...game, server: 'opponent' }, game], deps);
    expect(result.games.map(g => g.server)).toEqual(['opponent', 'player']);
  });
  it('previews a change that makes a completed set finish before its last game', async () => {
    const deps = await setup(); const initial = await startMatch({ ...input, format: 'oneSet' }, deps);
    const metrics = { netErrors: null, wideErrors: null, longErrors: null, doubleFaults: null, failedReturns: null };
    const added = await addGames(initial.match.id, ['lost', 'won', 'won', 'won', 'won', 'won', 'won'].map(result => ({ ...metrics, result: result as 'won' | 'lost' })), deps);
    const preview = await updateGame(added.games[0].id, { result: 'won' }, deps);
    expect(preview.conflicts.length).toBeGreaterThan(0);
    expect(await deps.repository.getMatchBundle(initial.match.id)).toEqual(added);
  });
  it('rejects a super tie-break without two split completed standard sets', async () => {
    const deps = await setup(); const initial = await startMatch(input, deps);
    const altered = structuredClone(initial);
    altered.sets[0].kind = 'decidingSuperTiebreak';
    await deps.repository.saveMatchBundle(altered);
    await expect(completeTieBreak({ setId: altered.sets[0].id, kind: 'super', playerPoints: 10, opponentPoints: 8, netErrors: null, wideErrors: null, longErrors: null, doubleFaults: null }, deps)).rejects.toThrow(/split/);
    expect(await deps.repository.getMatchBundle(initial.match.id)).toEqual(altered);
  });
  it('creates an opponent and default match with one standard set', async () => {
    const deps = await setup(); const result = await startMatch(input, deps);
    expect(result.opponent).toMatchObject({ name: 'Alex', normalizedName: 'alex' });
    expect(result.match).toMatchObject({ status: 'active', format: 'twoSetsSuperTiebreak', firstServer: 'player' });
    expect(result.sets).toMatchObject([{ ordinal: 1, kind: 'standard', status: 'active' }]);
    expect(await deps.repository.getActiveMatch()).toEqual(result);
  });
  it('reuses opponents case-insensitively and preserves records on abandonment', async () => {
    const deps = await setup(); const first = await startMatch(input, deps);
    await abandonActiveMatch(first.match.id, deps);
    expect(await deps.repository.getMatchBundle(first.match.id)).toMatchObject({ match: { status: 'abandoned' }, sets: first.sets });
    const second = await startMatch({ ...input, opponentName: 'aLEX' }, deps);
    expect(second.opponent.id).toBe(first.opponent.id);
    expect(await deps.repository.listOpponents()).toHaveLength(1);
  });
  it('rejects a second active match with an actionable conflict', async () => {
    const deps = await setup(); await startMatch(input, deps);
    await expect(startMatch(input, deps)).rejects.toThrow(/complete or abandon/i);
    expect(await deps.repository.listMatches()).toHaveLength(1);
  });
});

describe('review regressions', () => {
  const metrics = { netErrors: null, wideErrors: null, longErrors: null, doubleFaults: null, failedReturns: null };
  it.each(['player', 'opponent'] as const)('infers service after multiple standard tie-breaks starting with %s', async firstServer => {
    const deps = await setup(); const start = await startMatch({ ...input, firstServer, format: 'openPractice' }, deps);
    const games = Array.from({ length: 12 }, (_, i) => ({ ...metrics, result: i % 2 ? 'lost' as const : 'won' as const }));
    let b = await addGames(start.match.id, games, deps);
    await completeTieBreak({ setId: b.sets[0].id, kind: 'standard', playerPoints: 7, opponentPoints: 5, ...metrics }, deps);
    const opposite = firstServer === 'player' ? 'opponent' : 'player';
    b = await addGames(start.match.id, games, deps);
    expect(b.games[12].server).toBe(opposite);
    await completeTieBreak({ setId: b.sets[1].id, kind: 'standard', playerPoints: 7, opponentPoints: 5, ...metrics }, deps);
    b = await addGames(start.match.id, [{ ...metrics, result: 'won' }], deps);
    expect(b.games[24].server).toBe(firstServer);
  });
  it.each(['update', 'delete'] as const)('%s preview identifies all dependent records and confirmation preserves them', async operation => {
    const deps = await setup(); const start = await startMatch({ ...input, format: 'openPractice' }, deps);
    let b = await addGames(start.match.id, Array.from({ length: 6 }, () => ({ ...metrics, result: 'won' as const })), deps);
    b = await addGames(start.match.id, Array.from({ length: 12 }, (_, i) => ({ ...metrics, result: i % 2 ? 'lost' as const : 'won' as const })), deps);
    b = await completeTieBreak({ setId: b.sets[1].id, kind:'standard', playerPoints:7, opponentPoints:5, ...metrics }, deps);
    b = await addGames(start.match.id, [{ ...metrics, result:'won' }], deps);
    const save = vi.spyOn(deps.repository, 'saveMatchBundle');
    const run = (confirmed = false) => operation === 'update' ? updateGame(b.games[0].id, { result:'lost' }, deps, confirmed) : deleteGame(b.games[0].id, deps, confirmed);
    const preview = await run(); expect(save).not.toHaveBeenCalled();
    for (const set of b.sets.slice(1)) expect(preview.conflicts).toEqual(expect.arrayContaining([expect.objectContaining({ type:'structureInvalidated', setId:set.id })]));
    expect(preview.conflicts).toEqual(expect.arrayContaining([expect.objectContaining({ type:'structureInvalidated', tieBreakId:b.tieBreaks[0].id })]));
    for (const game of b.games.slice(6)) expect(preview.conflicts).toEqual(expect.arrayContaining([expect.objectContaining({ type:'structureInvalidated', gameId:game.id })]));
    const confirmed = await run(true); expect(save).toHaveBeenCalledTimes(1);
    expect(confirmed.bundle.sets).toEqual(b.sets); expect(confirmed.bundle.tieBreaks).toEqual(b.tieBreaks);
    expect(confirmed.bundle.games.slice(operation === 'delete' ? 5 : 6)).toEqual(b.games.slice(6));
  });
});

describe('same-set correction dependencies', () => {
  it.each(['update', 'delete'] as const)('%s previews the attached tie-break and later games without writes', async operation => {
    const deps = await setup(); const start = await startMatch({ ...input, format:'openPractice' }, deps);
    const metrics = { netErrors:null, wideErrors:null, longErrors:null, doubleFaults:null, failedReturns:null };
    const games = Array.from({ length:12 }, (_, i) => ({ ...metrics, result:i % 2 ? 'lost' as const : 'won' as const }));
    let before = await addGames(start.match.id, games, deps);
    before = await completeTieBreak({ setId:before.sets[0].id, kind:'standard', playerPoints:7, opponentPoints:5, ...metrics }, deps);
    const edited = before.games[3]; const save = vi.spyOn(deps.repository, 'saveMatchBundle');
    const run = (confirmed = false) => operation === 'update' ? updateGame(edited.id, { result:'won' }, deps, confirmed) : deleteGame(edited.id, deps, confirmed);
    const preview = await run();
    expect(save).not.toHaveBeenCalled(); expect(preview.bundle).toEqual(before);
    expect(preview.conflicts).toEqual(expect.arrayContaining([expect.objectContaining({ type:'structureInvalidated', setId:edited.setId, tieBreakId:before.tieBreaks[0].id })]));
    for (const game of before.games.slice(4)) expect(preview.conflicts.some(c => c.gameId === game.id && (c.type === 'structureInvalidated' || c.type === 'serverChanged'))).toBe(true);
    const result = await run(true); expect(save).toHaveBeenCalledTimes(1);
    expect(result.bundle.sets).toEqual(before.sets); expect(result.bundle.tieBreaks).toEqual(before.tieBreaks);
    expect(result.bundle.games.filter(g => g.id !== edited.id)).toEqual(before.games.filter(g => g.id !== edited.id));
  });
});

describe('post-completion chronology conflicts', () => {
  it.each(['update', 'delete'] as const)('%s identifies games after earliest completion with the same winner', async operation => {
    const deps = await setup(); const start = await startMatch({ ...input, format:'openPractice' }, deps);
    const metrics = { netErrors:null, wideErrors:null, longErrors:null, doubleFaults:null, failedReturns:null };
    const results = ['won','lost','won','lost','won','lost','won','lost','won','won'] as const;
    const before = await addGames(start.match.id, results.map(result => ({ ...metrics, result })), deps);
    if (operation === 'delete') {
      before.games[1].result = 'won';
      before.games.push({ ...before.games[9], id:'extra-game', ordinal:11, server:'player' });
      await deps.repository.saveMatchBundle(before);
    }
    const edited = before.games[operation === 'update' ? 1 : 3];
    const post = operation === 'update' ? [before.games[9]] : [before.games[9], before.games[10]];
    const save = vi.spyOn(deps.repository, 'saveMatchBundle');
    const run = (confirmed = false) => operation === 'update' ? updateGame(edited.id, { result:'won' }, deps, confirmed) : deleteGame(edited.id, deps, confirmed);
    const preview = await run(); expect(save).not.toHaveBeenCalled(); expect(preview.bundle).toEqual(before);
    for (const game of post) expect(preview.conflicts).toEqual(expect.arrayContaining([expect.objectContaining({ type:'structureInvalidated', setId:edited.setId, gameId:game.id })]));
    const result = await run(true); expect(save).toHaveBeenCalledTimes(1);
    expect(result.bundle.sets).toEqual(before.sets); expect(result.bundle.tieBreaks).toEqual(before.tieBreaks);
    expect(result.bundle.games.filter(g => g.id !== edited.id)).toEqual(before.games.filter(g => g.id !== edited.id));
  });
});

describe('post-match metadata and tie-break corrections', () => {
  const metrics = { netErrors:null, wideErrors:null, longErrors:null, doubleFaults:null, failedReturns:null };
  async function completedOneSet(deps: Awaited<ReturnType<typeof setup>>) {
    const start = await startMatch({ ...input, format:'oneSet' }, deps);
    const results = Array.from({ length:12 }, (_, i) => (i % 2 ? 'lost' : 'won') as 'won' | 'lost');
    await addGames(start.match.id, results.map(result => ({ ...metrics, result })), deps);
    return completeTieBreak({ setId:start.sets[0].id, kind:'standard', playerPoints:7, opponentPoints:5, netErrors:1, wideErrors:null, longErrors:null, doubleFaults:null }, deps);
  }
  it('updates opponent, date and format of a completed match without reactivating it', async () => {
    const deps = await setup(); const done = await completedOneSet(deps); expect(done.match.status).toBe('completed');
    const result = await updateMatchDetails(done.match.id, { opponentName:' Blake ', playedAt:'2026-02-03T10:00:00.000Z', format:'bestOfThree' }, deps);
    expect(result.conflicts.map(c => c.type)).toContain('matchOutcomeInvalidated');
    expect((await deps.repository.getMatchBundle(done.match.id))!.match.format).toBe('oneSet');
    const confirmed = await updateMatchDetails(done.match.id, { opponentName:' Blake ', playedAt:'2026-02-03T10:00:00.000Z', format:'bestOfThree' }, deps, true);
    const stored = (await deps.repository.getMatchBundle(done.match.id))!;
    expect(stored.opponent.name).toBe('Blake'); expect(stored.match.opponentId).toBe(stored.opponent.id); expect(stored.match.playedAt).toBe('2026-02-03T10:00:00.000Z');
    expect(stored.match.format).toBe('bestOfThree'); expect(stored.match.status).toBe('completed'); expect(confirmed.bundle.match.status).toBe('completed');
    expect(await deps.repository.getActiveMatch()).toBeUndefined();
    await expect(startMatch(input, deps)).resolves.toBeDefined();
  });
  it('reuses an existing opponent by name and applies non-disruptive edits immediately', async () => {
    const deps = await setup(); const first = await startMatch({ ...input, opponentName:'Casey' }, deps); await finishMatch(first.match.id, deps);
    const done = await completedOneSet(deps);
    const result = await updateMatchDetails(done.match.id, { opponentName:'casey', playedAt:'2026-03-01T09:00:00.000Z' }, deps);
    expect(result.conflicts).toEqual([]); expect(result.bundle.opponent.id).toBe(first.opponent.id);
    expect((await deps.repository.getMatchBundle(done.match.id))!.match.opponentId).toBe(first.opponent.id);
  });
  it('rejects invalid metadata', async () => {
    const deps = await setup(); const done = await completedOneSet(deps);
    await expect(updateMatchDetails(done.match.id, { playedAt:'nope' }, deps)).rejects.toThrow(/valid date/);
    await expect(updateMatchDetails(done.match.id, { opponentName:'  ' }, deps)).rejects.toThrow(/opponent name/);
    await expect(updateMatchDetails(done.match.id, { format:'bogus' as never }, deps)).rejects.toThrow(/format/);
    await expect(updateMatchDetails('missing', {}, deps)).rejects.toThrow(/not found/);
  });
  it('flags a format change that orphans a deciding super tie-break set', async () => {
    const deps = await setup(); const start = await startMatch(input, deps);
    const split = [...Array.from({ length:6 }, () => 'won' as const), ...Array.from({ length:6 }, () => 'lost' as const)];
    const mid = await addGames(start.match.id, split.map(result => ({ ...metrics, result })), deps);
    expect(mid.sets.find(s => s.kind === 'decidingSuperTiebreak')).toBeDefined();
    const result = await updateMatchDetails(start.match.id, { format:'openPractice' }, deps);
    expect(result.conflicts.map(c => c.type)).toContain('structureInvalidated');
  });
  it('corrects tie-break points with confirmation when the set outcome flips, keeping status', async () => {
    const deps = await setup(); const done = await completedOneSet(deps); const tie = done.tieBreaks[0];
    const quiet = await updateTieBreak(tie.id, { playerPoints:8, opponentPoints:6, netErrors:2, wideErrors:0, longErrors:null, doubleFaults:null }, deps);
    expect(quiet.conflicts).toEqual([]); expect((await deps.repository.getMatchBundle(done.match.id))!.tieBreaks[0]).toMatchObject({ playerPoints:8, netErrors:2, wideErrors:0 });
    const save = vi.spyOn(deps.repository, 'saveMatchBundle');
    const preview = await updateTieBreak(tie.id, { playerPoints:5, opponentPoints:7, netErrors:null, wideErrors:null, longErrors:null, doubleFaults:null }, deps);
    expect(preview.conflicts.map(c => c.type)).toEqual(expect.arrayContaining(['setOutcomeInvalidated', 'matchOutcomeInvalidated'])); expect(save).not.toHaveBeenCalled();
    const applied = await updateTieBreak(tie.id, { playerPoints:5, opponentPoints:7, netErrors:null, wideErrors:null, longErrors:null, doubleFaults:null }, deps, true);
    expect(applied.bundle.match.status).toBe('completed'); expect((await deps.repository.getMatchBundle(done.match.id))!.match.status).toBe('completed');
    await expect(updateTieBreak(tie.id, { playerPoints:7, opponentPoints:6, netErrors:null, wideErrors:null, longErrors:null, doubleFaults:null }, deps)).rejects.toThrow(/tie-break points/);
    await expect(updateTieBreak(tie.id, { playerPoints:7, opponentPoints:5, netErrors:-1, wideErrors:null, longErrors:null, doubleFaults:null }, deps)).rejects.toThrow(/non-negative/);
    await expect(updateTieBreak('missing', { playerPoints:7, opponentPoints:5, netErrors:null, wideErrors:null, longErrors:null, doubleFaults:null }, deps)).rejects.toThrow(/not found/);
  });
});

describe('format change structure revalidation', () => {
  const metrics = { netErrors:null, wideErrors:null, longErrors:null, doubleFaults:null, failedReturns:null };
  const six = (result: 'won' | 'lost') => Array.from({ length:6 }, () => ({ ...metrics, result }));
  async function bestOfThree(deps: Awaited<ReturnType<typeof setup>>, pattern: Array<'won' | 'lost'>) {
    const start = await startMatch({ ...input, format:'bestOfThree' }, deps);
    const done = await addGames(start.match.id, pattern.flatMap(six), deps);
    expect(done.match.status).toBe('completed'); expect(done.sets).toHaveLength(3);
    return done;
  }
  it.each([
    ['W-L-W', ['won', 'lost', 'won'] as const],
    ['L-W-W', ['lost', 'won', 'won'] as const],
  ])('%s best-of-three changed to one set flags every record after the set that decides it', async (_, pattern) => {
    const deps = await setup(); const done = await bestOfThree(deps, [...pattern]);
    const save = vi.spyOn(deps.repository, 'saveMatchBundle');
    const preview = await updateMatchDetails(done.match.id, { format:'oneSet' }, deps);
    expect(save).not.toHaveBeenCalled(); expect(preview.bundle.match.format).toBe('bestOfThree');
    const later = done.sets.filter(set => set.ordinal > 1);
    for (const set of later) {
      expect(preview.conflicts).toEqual(expect.arrayContaining([expect.objectContaining({ type:'structureInvalidated', setId:set.id })]));
      for (const game of done.games.filter(g => g.setId === set.id)) expect(preview.conflicts).toEqual(expect.arrayContaining([expect.objectContaining({ type:'structureInvalidated', setId:set.id, gameId:game.id })]));
    }
    expect(preview.conflicts.filter(c => c.setId === done.sets[0].id)).toEqual([]);
    const applied = await updateMatchDetails(done.match.id, { format:'oneSet' }, deps, true);
    expect(applied.bundle.match.format).toBe('oneSet'); expect(applied.bundle.match.status).toBe('completed');
  });
  it('flags later tie-breaks and stays quiet when the new format still needs every set', async () => {
    const deps = await setup(); const start = await startMatch({ ...input, format:'bestOfThree' }, deps);
    await addGames(start.match.id, six('won'), deps);
    const tied = await addGames(start.match.id, Array.from({ length:12 }, (_, i) => ({ ...metrics, result:(i % 2 ? 'lost' : 'won') as 'won' | 'lost' })), deps);
    const done = await completeTieBreak({ setId:tied.sets[1].id, kind:'standard', playerPoints:7, opponentPoints:2, netErrors:null, wideErrors:null, longErrors:null, doubleFaults:null }, deps);
    expect(done.match.status).toBe('completed');
    const preview = await updateMatchDetails(done.match.id, { format:'oneSet' }, deps);
    expect(preview.conflicts).toEqual(expect.arrayContaining([expect.objectContaining({ type:'structureInvalidated', setId:done.sets[1].id, tieBreakId:done.tieBreaks[0].id })]));
    expect((await updateMatchDetails(done.match.id, { format:'openPractice' }, deps)).conflicts.filter(c => c.type === 'structureInvalidated')).toEqual([]);
  });
  it('stores high-level stats and normalized comments on add and update', async () => {
    const deps = await setup(); const initial = await startMatch(input, deps);
    const base = { result: 'won' as const, netErrors: 4, wideErrors: null, longErrors: null, doubleFaults: null, failedReturns: null };
    const added = await addGames(initial.match.id, [{ ...base, unforcedErrors: 1, comments: '  rally  ' }, { ...base, comments: '   ' }], deps);
    expect(added.games.map(g => [g.unforcedErrors, g.netErrors, g.comments])).toEqual([[1, 4, 'rally'], [null, 4, null]]);
    const updated = await updateGame(added.games[1].id, { unforcedErrors: 2, comments: ' note ' }, deps);
    expect(updated.bundle.games[1]).toMatchObject({ unforcedErrors: 2, netErrors: 4, comments: 'note' });
    const cleared = await updateGame(added.games[1].id, { comments: '  ' }, deps);
    expect(cleared.bundle.games[1].comments).toBeNull();
  });
  it('rejects a 10,001 character game comment without saving', async () => {
    const deps = await setup(); const initial = await startMatch(input, deps);
    const base = { result: 'won' as const, netErrors: null, wideErrors: null, longErrors: null, doubleFaults: null, failedReturns: null };
    const long = 'x'.repeat(10_001);
    const save = vi.spyOn(deps.repository, 'saveMatchBundle');
    await expect(addGames(initial.match.id, [{ ...base, comments: long }], deps)).rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
    const added = await addGames(initial.match.id, [{ ...base, comments: 'x'.repeat(10_000) }], deps);
    save.mockClear();
    await expect(updateGame(added.games[0].id, { comments: long }, deps)).rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
  });
});
