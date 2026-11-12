import { describe, expect, it } from 'vitest';
import type { Game } from './model';
import { normalizeOpponentName, validateGame } from './validation';

const game = (overrides: Partial<Game> = {}): Game => ({
  id: 'game-1', setId: 'set-1', ordinal: 1, server: 'player',
  score: null, firstServesIn: 0, firstServesTotal: null,
  secondServesIn: null, secondServesTotal: null, aces: null,
  doubleFaults: null, winners: null, unforcedErrors: null,
  failedReturns: null, createdAt: '2026-11-11T00:00:00.000Z',
  updatedAt: '2026-11-11T00:00:00.000Z', ...overrides,
});

describe('domain validation', () => {
  it('trims opponent names and rejects empty names', () => {
    expect(normalizeOpponentName('  Casey  ')).toBe('Casey');
    expect(normalizeOpponentName('   ')).toBe('');
  });

  it('preserves valid IDs, timestamps, and explicit zero metrics', () => {
    const input = game();
    expect(validateGame(input)).toEqual({ ok: true, value: input });
  });

  it.each([-1, 1.5])('rejects invalid metric count %s', (count) => {
    expect(validateGame(game({ aces: count }))).toMatchObject({ ok: false });
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
