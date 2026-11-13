import type { Game, MatchBundle, RecordedMetric } from './model';

/**
 * Calendar semantics: a Date is mapped to the viewer's LOCAL calendar day
 * (device timezone) using native Date local accessors. `start` is the local
 * midnight beginning the period (inclusive); `end` is the local midnight
 * beginning the next period (exclusive). DST-safe because boundaries are built
 * from local calendar components, not by adding fixed milliseconds.
 * date-fns is not a dependency, so none is used.
 */
export interface DateRange { start: Date; end: Date }

export type DashboardMetric = 'unforcedErrors' | 'doubleFaults' | 'failedReturns';
export type StatisticsMetric = RecordedMetric | DashboardMetric;

export interface MetricSummary { key: StatisticsMetric; average: number | null; sampleSize: number }

export type TrendInsufficientReason = 'noCurrent' | 'noPrevious' | 'noBoth';
export type MetricTrend =
  | { state: 'compared'; direction: 'lower' | 'higher' | 'unchanged'; difference: number }
  | { state: 'insufficient'; reason: TrendInsufficientReason };

export interface MetricComparison { current: MetricSummary; previous: MetricSummary; trend: MetricTrend }
export interface DashboardSummary { metrics: Record<DashboardMetric, MetricComparison> }

export const RECORDED_METRICS: readonly RecordedMetric[] = ['netErrors', 'wideErrors', 'longErrors', 'doubleFaults', 'failedReturns'];
export const DASHBOARD_METRICS: readonly DashboardMetric[] = ['unforcedErrors', 'doubleFaults', 'failedReturns'];

export function getCalendarPeriod(reference: Date, unit: 'week' | 'month'): DateRange {
  const y = reference.getFullYear();
  const m = reference.getMonth();
  const d = reference.getDate();
  if (unit === 'month') return { start: new Date(y, m, 1), end: new Date(y, m + 1, 1) };
  const sinceMonday = (reference.getDay() + 6) % 7;
  return { start: new Date(y, m, d - sinceMonday), end: new Date(y, m, d - sinceMonday + 7) };
}

/** Normal games (tie-breaks are separate entities and never included) of matches whose playedAt falls in [start, end). */
export function gamesPlayedInRange(bundles: readonly MatchBundle[], range: DateRange): Game[] {
  const start = range.start.getTime();
  const end = range.end.getTime();
  return bundles.flatMap((bundle) => {
    const playedAt = new Date(bundle.match.playedAt).getTime();
    return Number.isNaN(playedAt) || playedAt < start || playedAt >= end ? [] : bundle.games;
  });
}

/** The explicit high-level total wins (even 0); otherwise the sum of recorded detail counts; null when nothing was recorded. */
export function effectiveUnforcedErrors(game: Pick<Game, 'unforcedErrors' | 'netErrors' | 'wideErrors' | 'longErrors'>): number | null {
  if (typeof game.unforcedErrors === 'number') return game.unforcedErrors;
  const components = [game.netErrors, game.wideErrors, game.longErrors];
  return components.every(component => component === null) ? null : components.reduce<number>((total, component) => total + (component ?? 0), 0);
}

function isEligible(game: Game, key: StatisticsMetric): boolean {
  if (key === 'failedReturns') return game.server === 'opponent';
  if (key === 'doubleFaults') return game.server === 'player';
  return true;
}

export function calculateMetric(games: readonly Game[], key: StatisticsMetric): MetricSummary {
  let sum = 0;
  let sampleSize = 0;
  for (const game of games) {
    const value: number | null = key === 'unforcedErrors' ? effectiveUnforcedErrors(game) : game[key];
    if (value === null || !isEligible(game, key)) continue;
    sum += value;
    sampleSize += 1;
  }
  return { key, average: sampleSize === 0 ? null : sum / sampleSize, sampleSize };
}

function compare(current: MetricSummary, previous: MetricSummary): MetricTrend {
  if (current.average === null || previous.average === null) {
    return { state: 'insufficient', reason: current.average === null && previous.average === null ? 'noBoth' : current.average === null ? 'noCurrent' : 'noPrevious' };
  }
  const difference = current.average - previous.average;
  return { state: 'compared', direction: difference < 0 ? 'lower' : difference > 0 ? 'higher' : 'unchanged', difference };
}

export function calculateDashboard(current: readonly Game[], previous: readonly Game[]): DashboardSummary {
  const metrics = {} as Record<DashboardMetric, MetricComparison>;
  for (const key of DASHBOARD_METRICS) {
    const cur = calculateMetric(current, key);
    const prev = calculateMetric(previous, key);
    metrics[key] = { current: cur, previous: prev, trend: compare(cur, prev) };
  }
  return { metrics };
}
