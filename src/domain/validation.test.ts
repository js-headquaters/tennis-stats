import { describe, expect, it } from 'vitest';
import type { Game, MatchFormat, MatchStatus, TennisSet, TieBreak } from './model';
import { GAME_COMMENT_MAX_LENGTH, normalizeGameComment, normalizeOpponentName, validateGame } from './validation';

const game = (overrides: Partial<Game> = {}): Game => ({
  id: 'game-1', setId: 'set-1', ordinal: 1, server: 'player', result: 'won',
  score: null, netErrors: 0, wideErrors: null, longErrors: null,
  doubleFaults: null, failedReturns: null, unforcedErrors: null, comments: null, createdAt: '2026-11-11T00:00:00.000Z',
  updatedAt: '2026-11-11T00:00:00.000Z', ...overrides,
});

describe('domain validation', () => {
  it('normalizes game comments', () => {
    expect(GAME_COMMENT_MAX_LENGTH).toBe(10_000);
    expect(normalizeGameComment('  hi  ')).toBe('hi');
    expect(normalizeGameComment('   ')).toBeNull();
    expect(normalizeGameComment(null)).toBeNull();
  });
  it('validates unforcedErrors and comments', () => {
    expect(validateGame(game({ unforcedErrors: 0, comments: 'ok' }))).toMatchObject({ ok: true });
    for (const bad of [-1, 1.5]) expect(validateGame(game({ unforcedErrors: bad }))).toMatchObject({ ok: false });
    expect(validateGame(game({ comments: 'x'.repeat(10_000) }))).toMatchObject({ ok: true });
    expect(validateGame(game({ comments: 'x'.repeat(10_001) }))).toMatchObject({ ok: false });
    expect(validateGame(game({ comments: 5 as unknown as string }))).toMatchObject({ ok: false });
  });
  it('trims opponent names and rejects empty names', () => {
    expect(normalizeOpponentName('  Casey  ')).toBe('Casey');
    expect(normalizeOpponentName('   ')).toBe('');
  });

  it('preserves valid IDs, timestamps, and explicit zero metrics', () => {
    const input = game();
    expect(validateGame(input)).toEqual({ ok: true, value: input });
  });

  it.each([-1, 1.5])('rejects invalid metric count %s', (count) => {
    expect(validateGame(game({ netErrors: count }))).toMatchObject({ ok: false });
  });

  it('pins the exact match formats and statuses', () => {
    const formats: MatchFormat[] = ['twoSetsSuperTiebreak', 'openPractice', 'oneSet', 'bestOfThree'];
    const statuses: MatchStatus[] = ['active', 'completed', 'abandoned'];
    expect(formats).toHaveLength(4);
    expect(statuses).toHaveLength(3);
  });

  it('pins required game result and five tracked metrics', () => {
    const input = game({ result: 'lost', netErrors: 0, wideErrors: null, longErrors: null, doubleFaults: null, failedReturns: null });
    expect(validateGame(input)).toEqual({ ok: true, value: input });
    expect(Object.keys(input).filter((key) => ['netErrors', 'wideErrors', 'longErrors', 'doubleFaults', 'failedReturns'].includes(key))).toHaveLength(5);
  });

  it('pins set and tie-break domain values', () => {
    const set = { kind: 'decidingSuperTiebreak', status: 'unfinished' } satisfies Pick<TennisSet, 'kind' | 'status'>;
    const tieBreak = { kind: 'super', netErrors: null, wideErrors: null, longErrors: null, doubleFaults: 0 } satisfies Pick<TieBreak, 'kind' | 'netErrors' | 'wideErrors' | 'longErrors' | 'doubleFaults'>;
    expect(set.kind).toBe('decidingSuperTiebreak');
    expect(tieBreak.doubleFaults).toBe(0);
  });

  it.each(['unknown', '', null])('rejects invalid server %s', (server) => {
    expect(validateGame(game({ server } as unknown as Partial<Game>))).toMatchObject({ ok: false });
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid ordinal %s', (ordinal) => {
    expect(validateGame(game({ ordinal }))).toMatchObject({ ok: false });
  });

  it('accepts zero ordinal', () => {
    expect(validateGame(game({ ordinal: 0 })).ok).toBe(true);
  });

  it.each([{ player: 'Love', opponent: '0' }, { player: '15', opponent: 40 }, {}])('rejects malformed score %o', (score) => {
    expect(validateGame(game({ score } as unknown as Partial<Game>))).toMatchObject({ ok: false });
  });

  it('accepts the allowed score boundary values', () => {
    expect(validateGame(game({ score: { player: '0', opponent: 'AD' } })).ok).toBe(true);
  });

  it('rejects failed returns when the player served', () => {
    expect(validateGame(game({ failedReturns: 1 }))).toMatchObject({ ok: false });
  });

  it('rejects double faults when the opponent served', () => {
    expect(validateGame(game({ server: 'opponent', doubleFaults: 1 }))).toMatchObject({ ok: false });
  });
});
