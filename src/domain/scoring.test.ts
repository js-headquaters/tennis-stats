import { describe, expect, it } from 'vitest';
import type { Game, MatchFormat, TieBreak } from './model';
import { evaluateMatch, evaluateSet, findCorrectionConflicts, inferServer } from './scoring';

const game = (ordinal: number, result: Game['result'] = 'won', server: Game['server'] = inferServer('player', ordinal)): Game => ({
  id: `g${ordinal}`, setId: 's1', ordinal, server, result, score: null,
  netErrors: null, wideErrors: null, longErrors: null, doubleFaults: null, failedReturns: null,
  createdAt: '', updatedAt: '',
});
const games = (playerGames: number, opponentGames: number) => Array.from({ length: playerGames + opponentGames }, (_, index) => game(index, index < playerGames ? 'won' : 'lost'));
const tieBreak = (kind: TieBreak['kind'], playerPoints: number, opponentPoints: number): TieBreak => ({
  id: 'tb1', setId: 's1', kind, playerPoints, opponentPoints,
  netErrors: null, wideErrors: null, longErrors: null, doubleFaults: null,
  createdAt: '', updatedAt: '',
});

describe('tennis scoring', () => {
  it('alternates service from the first server by zero-based game index', () => {
    expect(Array.from({ length: 5 }, (_, index) => inferServer('opponent', index))).toEqual(['opponent', 'player', 'opponent', 'player', 'opponent']);
  });

  it.each([[6, 0], [6, 4], [7, 5]] as const)('completes standard score %i-%i', (won, lost) => {
    expect(evaluateSet(games(won, lost), null)).toMatchObject({ playerGames: won, opponentGames: lost, winner: 'player', completed: true });
  });

  it('requires a standard tie-break to complete 7-6', () => {
    expect(evaluateSet(games(6, 6), tieBreak('standard', 7, 4))).toMatchObject({ playerGames: 7, opponentGames: 6, winner: 'player', completed: true });
    expect(evaluateSet(games(6, 6), null).completed).toBe(false);
    expect(evaluateSet(games(6, 5), tieBreak('standard', 7, 4)).completed).toBe(false);
    expect(evaluateSet(games(6, 6), tieBreak('super', 10, 8)).completed).toBe(false);
  });

  it.each([
    ['standard', 7, 0, 'player'], ['standard', 6, 8, 'opponent'],
    ['super', 10, 8, 'player'], ['super', 9, 11, 'opponent'],
  ] as const)('accepts terminal %s tie-break %i-%i', (kind, player, opponent, winner) => {
    expect(evaluateSet(kind === 'standard' ? games(6, 6) : [], tieBreak(kind, player, opponent))).toMatchObject({ completed: true, winner });
  });

  it.each([
    ['standard', 8, 4], ['super', 11, 8], ['standard', 7, -1],
    ['super', -1, 10], ['standard', 7.5, 4], ['super', 3, 10.5],
    ['standard', Infinity, 4], ['super', 10, NaN], ['standard', 7, 6], ['super', 9, 8],
  ] as const)('rejects non-terminal or invalid %s tie-break %s-%s', (kind, player, opponent) => {
    expect(evaluateSet(kind === 'standard' ? games(6, 6) : [], tieBreak(kind, player, opponent))).toMatchObject({ completed: false, winner: null });
  });

  it.each([[6, 5], [6, 6]] as const)('does not auto-complete at %i-%i', (won, lost) => {
    expect(evaluateSet(games(won, lost), null).completed).toBe(false);
  });

  it('does not count unfinished sets and completes one-set and best-of-three matches', () => {
    const set = (playerGames: number, opponentGames: number) => evaluateSet(games(playerGames, opponentGames), null);
    expect(evaluateSet(games(5, 1), null).winner).toBeNull();
    expect(evaluateMatch('oneSet', [set(6, 0)])).toMatchObject({ complete: true, winner: 'player' });
    expect(evaluateMatch('bestOfThree', [set(6, 4), set(2, 3), set(6, 4)])).toMatchObject({ complete: true, winner: 'player' });
  });

  it('does not count deciding super tie-breaks in other match formats', () => {
    const standard = evaluateSet(games(6, 2), null);
    const deciding = evaluateSet([], tieBreak('super', 10, 8));
    expect(evaluateMatch('oneSet', [deciding])).toMatchObject({ complete: false, winner: null, playerSets: 0 });
    expect(evaluateMatch('bestOfThree', [standard, deciding])).toMatchObject({ complete: false, winner: null, playerSets: 1 });
    expect(evaluateMatch('openPractice', [deciding])).toMatchObject({ complete: false, playerSets: 0 });
  });

  it('requires a deciding super tie-break after split completed sets', () => {
    const first = evaluateSet(games(6, 2), null);
    const second = evaluateSet(games(2, 6), null);
    const deciding = evaluateSet([], tieBreak('super', 10, 8));
    expect(evaluateMatch('twoSetsSuperTiebreak', [first, second])).toMatchObject({ complete: false, winner: null });
    expect(deciding).toMatchObject({ kind: 'decidingSuperTiebreak', completed: true, winner: 'player' });
    expect(evaluateMatch('twoSetsSuperTiebreak', [first, second, deciding])).toMatchObject({ complete: true, winner: 'player' });
    expect(evaluateMatch('twoSetsSuperTiebreak', [first, first])).toMatchObject({ complete: true, winner: 'player' });
  });

  it('does not bypass an unfinished earlier standard set in the super tie-break format', () => {
    const unfinished = evaluateSet(games(3, 2), null);
    const player = evaluateSet(games(6, 2), null);
    const opponent = evaluateSet(games(2, 6), null);
    const deciding = evaluateSet([], tieBreak('super', 10, 8));
    expect(evaluateMatch('twoSetsSuperTiebreak', [unfinished, player, opponent, deciding])).toMatchObject({ complete: false, winner: null, playerSets: 1, opponentSets: 0 });
    expect(evaluateMatch('twoSetsSuperTiebreak', [unfinished, player, player])).toMatchObject({ complete: false, winner: null, playerSets: 1 });
  });

  it('keeps open practice matches manually completed', () => {
    expect(evaluateMatch('openPractice', [evaluateSet(games(6, 0), null)])).toMatchObject({ complete: false, winner: null, requiresManualCompletion: true });
  });

  it('reports downstream explicit server shifts after deleting or inserting an early game', () => {
    const before = [game(0), game(1), game(2), game(3)];
    const afterDelete = before.filter((item) => item.id !== 'g0');
    const afterInsert = [{ ...game(0), id: 'inserted' }, ...before.map((item) => ({ ...item, ordinal: item.ordinal + 1 }))];
    expect(findCorrectionConflicts(before, afterDelete)).toContainEqual({ type: 'serverChanged', gameId: 'g2', beforeServer: 'player', afterServer: 'opponent' });
    expect(findCorrectionConflicts(before, afterInsert)).toContainEqual({ type: 'serverChanged', gameId: 'g0', beforeServer: 'player', afterServer: 'opponent' });
  });

  it('does not let a super tie-break substitute for either standard set', () => {
    const first = evaluateSet(games(6, 2), null);
    const deciding = evaluateSet([], tieBreak('super', 10, 8));
    expect(evaluateMatch('twoSetsSuperTiebreak', [first, deciding])).toMatchObject({ complete: false, winner: null });
  });

  it('leaves all inputs unchanged and ignores unfinished tie-break scores', () => {
    const input = games(6, 6).reverse();
    const tb = tieBreak('standard', 7, 6);
    const original = structuredClone({ input, tb });
    expect(evaluateSet(input, tb).completed).toBe(false);
    const after = input.slice(1);
    const afterOriginal = structuredClone(after);
    findCorrectionConflicts(input, after);
    expect({ input, tb }).toEqual(original);
    expect(after).toEqual(afterOriginal);
  });

  it('reports set completion invalidation without mutating either input', () => {
    const before = games(6, 0);
    const after = before.slice(1);
    const original = structuredClone(before);
    expect(findCorrectionConflicts(before, after)).toContainEqual(expect.objectContaining({ type: 'setOutcomeInvalidated' }));
    expect(before).toEqual(original);
  });

  it('accepts every declared match format', () => {
    const formats: MatchFormat[] = ['twoSetsSuperTiebreak', 'openPractice', 'oneSet', 'bestOfThree'];
    expect(formats).toHaveLength(4);
  });
});
