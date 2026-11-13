import { Link } from 'react-router-dom';
import { useEffect, useMemo, useState } from 'react';
import { dependencies } from '../../app/dependencies';
import type { Clock, TennisRepository } from '../../application/ports';
import type { MatchBundle, MatchStatus } from '../../domain/model';
import { DASHBOARD_METRICS, calculateDashboard, calculateMetric, gamesPlayedInRange } from '../../domain/statistics';
import MetricCard from './MetricCard';
import { formatDay, periodAt, periodLabel, previousPeriod, shortPeriodLabel, type PeriodUnit } from './periods';
import { matchLivePath, matchPath } from '../../app/routes';

const HISTORY_LENGTH = 6;
const RECENT_LIMIT = 5;
const STATUS_LABEL: Record<MatchStatus, string> = { active: 'In progress', completed: 'Completed', abandoned: 'Abandoned' };

interface Loaded { active: MatchBundle | undefined; activeFailed: boolean; bundles: MatchBundle[] | undefined; skipped: number }

async function loadBundles(repository: TennisRepository) {
  const matches = await repository.listMatches();
  const results = await Promise.allSettled(matches.map(match => repository.getMatchBundle(match.id)));
  const bundles = results.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : []);
  return { bundles, skipped: results.filter(result => result.status === 'rejected').length };
}

/** The active match loads independently so a broken statistics load (or one corrupt bundle) cannot hide the resume path. */
async function loadDashboard(repository: TennisRepository): Promise<Loaded> {
  const [active, statistics] = await Promise.allSettled([repository.getActiveMatch(), loadBundles(repository)]);
  return {
    active: active.status === 'fulfilled' ? active.value : undefined,
    activeFailed: active.status === 'rejected',
    bundles: statistics.status === 'fulfilled' ? statistics.value.bundles : undefined,
    skipped: statistics.status === 'fulfilled' ? statistics.value.skipped : 0,
  };
}

function playedAtTime(bundle: MatchBundle) {
  const time = new Date(bundle.match.playedAt).getTime();
  return Number.isNaN(time) ? -Infinity : time;
}

export default function DashboardPage({ repository, clock }: { repository?: TennisRepository; clock?: Clock }) {
  const [reference] = useState(() => new Date((clock ?? dependencies.clock).now()));
  const [unit, setUnit] = useState<PeriodUnit>('week');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<Loaded>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let owned: TennisRepository | undefined;
    void (async () => {
      try {
        const current = repository ?? (owned = await dependencies.openDatabase());
        if (cancelled) return;
        const loaded = await loadDashboard(current);
        if (!cancelled) setData(loaded);
      } catch { if (!cancelled) setFailed(true); }
      finally { owned?.close(); owned = undefined; }
    })();
    return () => { cancelled = true; };
  }, [repository, attempt]);

  const view = useMemo(() => {
    if (!data?.bundles) return undefined;
    const bundles = data.bundles;
    const selected = periodAt(reference, unit, offset);
    const summary = calculateDashboard(gamesPlayedInRange(bundles, selected), gamesPlayedInRange(bundles, previousPeriod(selected, unit)));
    const ranges = Array.from({ length: HISTORY_LENGTH }, (_, index) => periodAt(reference, unit, offset - (HISTORY_LENGTH - 1 - index)));
    const historyGames = ranges.map(range => gamesPlayedInRange(bundles, range));
    const history = Object.fromEntries(DASHBOARD_METRICS.map(key => [key, ranges.map((range, index) => {
      const { average, sampleSize } = calculateMetric(historyGames[index], key);
      return { label: periodLabel(range, unit), shortLabel: shortPeriodLabel(range, unit), average, sampleSize };
    })]));
    const recent = [...bundles].sort((a, b) => playedAtTime(b) - playedAtTime(a)).slice(0, RECENT_LIMIT);
    return { label: periodLabel(selected, unit), summary, history, recent };
  }, [data, reference, unit, offset]);

  function chooseUnit(next: PeriodUnit) { setUnit(next); setOffset(0); }
  function retry() { setFailed(false); setData(undefined); setAttempt(value => value + 1); }

  const statisticsFailed = failed || (data !== undefined && data.bundles === undefined);
  return <section className="dashboard"><h1>Home</h1>
    {data?.activeFailed && <div><p role="alert">Unable to load the active match.</p><button type="button" onClick={retry}>Retry active match</button></div>}
    {data?.active && <section aria-label="Active match" className="resume-card"><h2>Match in progress</h2><p>Against {data.active.opponent.name}</p><Link className="action-link" to={matchLivePath(data.active.match.id)}>Resume match</Link></section>}
    <section aria-labelledby="statistics-heading" className="dashboard-statistics"><h2 id="statistics-heading">Statistics</h2>
      {statisticsFailed ? <div><p role="alert">Unable to load statistics.</p><button type="button" onClick={retry}>Retry</button></div>
        : !view ? <p>Loading statistics…</p>
        : <>
          <div className="period-units" role="group" aria-label="Period type">
            {(['week', 'month'] as const).map(value => <button key={value} type="button" aria-pressed={unit === value} onClick={() => chooseUnit(value)}>{value === 'week' ? 'Week' : 'Month'}</button>)}
          </div>
          <div className="period-nav">
            <button type="button" onClick={() => setOffset(value => value - 1)}>Previous {unit}</button>
            <h3 aria-live="polite">{view.label}</h3>
            <button type="button" disabled={offset >= 0} onClick={() => setOffset(value => Math.min(0, value + 1))}>Next {unit}</button>
          </div>
          {data!.skipped > 0 && <p role="status">{data!.skipped === 1 ? '1 match could not be loaded and is not included.' : `${data!.skipped} matches could not be loaded and are not included.`}</p>}
          <div className="metric-cards">
            {DASHBOARD_METRICS.map(key => <MetricCard key={key} metric={key} unit={unit} comparison={view.summary.metrics[key]} history={view.history[key]} />)}
          </div>
        </>}
    </section>
    {view && <section aria-labelledby="recent-heading" className="recent-matches"><h2 id="recent-heading">Recent matches</h2>
      {view.recent.length === 0 ? <p>No matches recorded yet.</p> : <ul>{view.recent.map(({ match, opponent }) => <li key={match.id}>
        <Link className="touch-link" to={matchPath(match.id)}>{opponent.name}</Link>
        <span>{Number.isNaN(new Date(match.playedAt).getTime()) ? 'Unknown date' : formatDay(new Date(match.playedAt))}</span>
        <span>{STATUS_LABEL[match.status]}</span>
      </li>)}</ul>}
    </section>}
    <Link className="action-link floating-action" to="/matches/new">Start new match</Link>
  </section>;
}
