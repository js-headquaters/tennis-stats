import { describe, expect, it } from 'vitest';
import type { Game, Match, MatchBundle, RecordedMetric } from './model';
import { calculateDashboard, calculateMetric, gamesPlayedInRange, getCalendarPeriod } from './statistics';

// All dates are built from local-calendar components so assertions hold in any TZ.
const local = (y: number, m: number, d: number, h = 0, min = 0, s = 0, ms = 0) => new Date(y, m - 1, d, h, min, s, ms);
const ymd = (d: Date) => [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()];

type Over = Partial<Pick<Game, 'server' | 'netErrors' | 'wideErrors' | 'longErrors' | 'doubleFaults' | 'failedReturns'>>;
let seq = 0;
const game = (over: Over = {}): Game => ({
  id: `g${seq++}`, setId: 's1', ordinal: seq, server: 'player', result: 'won', score: null,
  netErrors: null, wideErrors: null, longErrors: null, doubleFaults: null, failedReturns: null,
  createdAt: '', updatedAt: '', ...over,
});
const bundle = (playedAt: Date, games: Game[]): MatchBundle => ({
  match: { id: `m${seq++}`, opponentId: 'o', playedAt: playedAt.toISOString(), format: 'oneSet', firstServer: 'player', status: 'completed', comments: null, createdAt: '', updatedAt: '' } as Match,
  opponent: { id: 'o', name: 'O', normalizedName: 'o', createdAt: '', updatedAt: '' },
  sets: [], games, tieBreaks: [],
});

describe('getCalendarPeriod', () => {
  it('uses Monday to Sunday weeks (Wed 2026-11-11 -> Mon 11-09 .. next Mon 11-16 exclusive)', () => {
    const r = getCalendarPeriod(local(2026, 11, 11, 15, 30), 'week');
    expect(ymd(r.start)).toEqual([2026, 11, 9, 0, 0]);
    expect(ymd(r.end)).toEqual([2026, 11, 16, 0, 0]);
  });
  it('treats Sunday as the last day of its week and Monday as the first', () => {
    expect(ymd(getCalendarPeriod(local(2026, 11, 15, 23, 59), 'week').start)).toEqual([2026, 11, 9, 0, 0]);
    expect(ymd(getCalendarPeriod(local(2026, 11, 16, 0, 0), 'week').start)).toEqual([2026, 11, 16, 0, 0]);
  });
  it('uses calendar months, including year rollover and leap February', () => {
    const dec = getCalendarPeriod(local(2026, 12, 31, 23, 59), 'month');
    expect(ymd(dec.start)).toEqual([2026, 12, 1, 0, 0]);
    expect(ymd(dec.end)).toEqual([2027, 1, 1, 0, 0]);
    const feb = getCalendarPeriod(local(2028, 2, 10), 'month');
    expect(ymd(feb.end)).toEqual([2028, 3, 1, 0, 0]);
  });
  it('returns the immediately preceding equivalent period via the end of the previous range', () => {
    const cur = getCalendarPeriod(local(2026, 11, 11), 'week');
    const prev = getCalendarPeriod(new Date(cur.start.getTime() - 1), 'week');
    expect(ymd(prev.start)).toEqual([2026, 11, 2, 0, 0]);
    expect(prev.end.getTime()).toBe(cur.start.getTime());
    const prevMonth = getCalendarPeriod(new Date(getCalendarPeriod(local(2026, 3, 15), 'month').start.getTime() - 1), 'month');
    expect(ymd(prevMonth.start)).toEqual([2026, 2, 1, 0, 0]);
  });
});

describe('gamesPlayedInRange', () => {
  it('includes by Match.playedAt with inclusive start and exclusive end', () => {
    const range = getCalendarPeriod(local(2026, 11, 11), 'week');
    const inStart = game(); const inEnd = game(); const before = game(); const after = game();
    const games = gamesPlayedInRange([
      bundle(local(2026, 11, 9, 0, 0), [inStart]),
      bundle(local(2026, 11, 15, 23, 59, 59, 999), [inEnd]),
      bundle(local(2026, 11, 8, 23, 59, 59, 999), [before]),
      bundle(local(2026, 11, 16, 0, 0), [after]),
    ], range);
    expect(games).toEqual([inStart, inEnd]);
  });
  it('ignores createdAt and skips matches with invalid playedAt', () => {
    const range = getCalendarPeriod(local(2026, 11, 11), 'week');
    const b = bundle(local(2026, 10, 1), [game()]);
    b.match.createdAt = local(2026, 11, 10).toISOString();
    const bad = bundle(local(2026, 11, 10), [game()]);
    bad.match.playedAt = 'nope';
    expect(gamesPlayedInRange([b, bad], range)).toEqual([]);
  });
  it('excludes tie-breaks with nonzero errors from averages and sample sizes', () => {
    const range = getCalendarPeriod(local(2026, 11, 11), 'week');
    const b = bundle(local(2026, 11, 10), [game({ server: 'player', netErrors: 1, wideErrors: 0, longErrors: 2, doubleFaults: 0 }), game({ server: 'opponent', netErrors: 1, failedReturns: 1 })]);
    b.tieBreaks = [{ id: 'tb', setId: 's1', kind: 'super', playerPoints: 10, opponentPoints: 8, netErrors: 9, wideErrors: 7, longErrors: 5, doubleFaults: 3, createdAt: '', updatedAt: '' }];
    const d = calculateDashboard(gamesPlayedInRange([b], range), []);
    expect(d.metrics.netErrors.current).toEqual({ key: 'netErrors', average: 1, sampleSize: 2 });
    expect(d.metrics.wideErrors.current).toEqual({ key: 'wideErrors', average: 0, sampleSize: 1 });
    expect(d.metrics.longErrors.current).toEqual({ key: 'longErrors', average: 2, sampleSize: 1 });
    expect(d.metrics.doubleFaults.current).toEqual({ key: 'doubleFaults', average: 0, sampleSize: 1 });
    expect(d.metrics.failedReturns.current).toEqual({ key: 'failedReturns', average: 1, sampleSize: 1 });
  });
});

describe('calculateMetric', () => {
  it('averages known values per metric with a per-metric denominator', () => {
    const s = calculateMetric([game({ netErrors: 2 }), game({ netErrors: 4 }), game({ netErrors: null }), game({ wideErrors: 9 })], 'netErrors');
    expect(s).toEqual({ key: 'netErrors', average: 3, sampleSize: 2 });
  });
  it('counts explicit zero and leaves null out', () => {
    expect(calculateMetric([game({ longErrors: 0 }), game({ longErrors: 3 }), game()], 'longErrors')).toEqual({ key: 'longErrors', average: 1.5, sampleSize: 2 });
  });
  it('returns null average and zero sample when nothing is known', () => {
    expect(calculateMetric([game(), game()], 'wideErrors')).toEqual({ key: 'wideErrors', average: null, sampleSize: 0 });
    expect(calculateMetric([], 'netErrors')).toEqual({ key: 'netErrors', average: null, sampleSize: 0 });
  });
  it('counts net/wide/long in both service and return games', () => {
    expect(calculateMetric([game({ server: 'player', netErrors: 1 }), game({ server: 'opponent', netErrors: 3 })], 'netErrors').sampleSize).toBe(2);
  });
  it('restricts failed returns to return games (opponent served) with a known value', () => {
    const s = calculateMetric([
      game({ server: 'opponent', failedReturns: 2 }),
      game({ server: 'opponent', failedReturns: 0 }),
      game({ server: 'opponent', failedReturns: null }),
      game({ server: 'player', failedReturns: 5 }),
    ], 'failedReturns');
    expect(s).toEqual({ key: 'failedReturns', average: 1, sampleSize: 2 });
  });
  it('restricts double faults to player-service games', () => {
    const s = calculateMetric([game({ server: 'player', doubleFaults: 1 }), game({ server: 'player', doubleFaults: 0 }), game({ server: 'opponent', doubleFaults: 4 })], 'doubleFaults');
    expect(s).toEqual({ key: 'doubleFaults', average: 0.5, sampleSize: 2 });
  });
  it('does not expose raw totals', () => {
    expect(Object.keys(calculateMetric([game({ netErrors: 1 })], 'netErrors')).sort()).toEqual(['average', 'key', 'sampleSize']);
  });
});

describe('calculateDashboard', () => {
  const keys: RecordedMetric[] = ['netErrors', 'wideErrors', 'longErrors', 'doubleFaults', 'failedReturns'];
  it('summarises all five metrics for both periods', () => {
    const d = calculateDashboard([game({ netErrors: 1 })], [game({ netErrors: 3 })]);
    expect(keys.every((k) => d.metrics[k].current.key === k)).toBe(true);
    expect(d.metrics.netErrors.current).toEqual({ key: 'netErrors', average: 1, sampleSize: 1 });
    expect(d.metrics.netErrors.previous.average).toBe(3);
  });
  it('reports lower/higher/unchanged with the signed difference', () => {
    expect(calculateDashboard([game({ netErrors: 1 })], [game({ netErrors: 3 })]).metrics.netErrors.trend).toEqual({ state: 'compared', direction: 'lower', difference: -2 });
    expect(calculateDashboard([game({ netErrors: 5 })], [game({ netErrors: 3 })]).metrics.netErrors.trend).toEqual({ state: 'compared', direction: 'higher', difference: 2 });
    expect(calculateDashboard([game({ netErrors: 3 })], [game({ netErrors: 3 })]).metrics.netErrors.trend).toEqual({ state: 'compared', direction: 'unchanged', difference: 0 });
  });
  it('gives an explicit no-comparison state when either period lacks a sample', () => {
    expect(calculateDashboard([game({ netErrors: 1 })], []).metrics.netErrors.trend).toEqual({ state: 'insufficient', reason: 'noPrevious' });
    expect(calculateDashboard([], [game({ netErrors: 1 })]).metrics.netErrors.trend).toEqual({ state: 'insufficient', reason: 'noCurrent' });
    expect(calculateDashboard([], []).metrics.netErrors.trend).toEqual({ state: 'insufficient', reason: 'noBoth' });
  });
  it('treats an average of zero with a sample as a real value', () => {
    expect(calculateDashboard([game({ netErrors: 0 })], [game({ netErrors: 2 })]).metrics.netErrors.trend).toMatchObject({ state: 'compared', direction: 'lower' });
  });
});
