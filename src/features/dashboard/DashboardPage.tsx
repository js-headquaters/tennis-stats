import { Link } from 'react-router-dom';
import { useEffect, useMemo, useState } from 'react';
import { dependencies } from '../../app/dependencies';
import type { Clock, TennisRepository } from '../../application/ports';
import type { MatchBundle, MatchStatus } from '../../domain/model';
import { RECORDED_METRICS, calculateDashboard, calculateMetric, gamesPlayedInRange } from '../../domain/statistics';
import MetricCard from './MetricCard';
import { formatDay, periodAt, periodLabel, previousPeriod, shortPeriodLabel, type PeriodUnit } from './periods';

const HISTORY_LENGTH = 6;
const RECENT_LIMIT = 5;
const STATUS_LABEL: Record<MatchStatus, string> = { active: 'In progress', completed: 'Completed', abandoned: 'Abandoned' };

interface Loaded { active: MatchBundle | undefined; bundles: MatchBundle[] }

async function loadDashboard(repository: TennisRepository): Promise<Loaded> {
  const [active, matches] = await Promise.all([repository.getActiveMatch(), repository.listMatches()]);
  const bundles = await Promise.all(matches.map(match => repository.getMatchBundle(match.id)));
  return { active, bundles: bundles.filter((bundle): bundle is MatchBundle => bundle !== undefined) };
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
    if (!data) return undefined;
    const selected = periodAt(reference, unit, offset);
    const summary = calculateDashboard(gamesPlayedInRange(data.bundles, selected), gamesPlayedInRange(data.bundles, previousPeriod(selected, unit)));
    const ranges = Array.from({ length: HISTORY_LENGTH }, (_, index) => periodAt(reference, unit, offset - (HISTORY_LENGTH - 1 - index)));
    const historyGames = ranges.map(range => gamesPlayedInRange(data.bundles, range));
    const history = Object.fromEntries(RECORDED_METRICS.map(key => [key, ranges.map((range, index) => {
      const { average, sampleSize } = calculateMetric(historyGames[index], key);
      return { label: periodLabel(range, unit), shortLabel: shortPeriodLabel(range, unit), average, sampleSize };
    })]));
    const recent = [...data.bundles].sort((a, b) => playedAtTime(b) - playedAtTime(a)).slice(0, RECENT_LIMIT);
    return { label: periodLabel(selected, unit), summary, history, recent };
  }, [data, reference, unit, offset]);

  function chooseUnit(next: PeriodUnit) { setUnit(next); setOffset(0); }
  function retry() { setFailed(false); setAttempt(value => value + 1); }

  return <section className="dashboard"><h1>Home</h1>
    <section aria-labelledby="statistics-heading" className="dashboard-statistics"><h2 id="statistics-heading">Statistics</h2>
      {failed ? <div><p role="alert">Unable to load statistics.</p><button type="button" onClick={retry}>Retry</button></div>
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
          <div className="metric-cards">
            {RECORDED_METRICS.map(key => <MetricCard key={key} metric={key} unit={unit} comparison={view.summary.metrics[key]} history={view.history[key]} />)}
          </div>
        </>}
    </section>
    {data?.active && <section aria-label="Active match" className="resume-card"><h2>Match in progress</h2><p>Against {data.active.opponent.name}</p><Link className="action-link" to={`/matches/${data.active.match.id}/live`}>Resume match</Link></section>}
    {view && <section aria-labelledby="recent-heading" className="recent-matches"><h2 id="recent-heading">Recent matches</h2>
      {view.recent.length === 0 ? <p>No matches recorded yet.</p> : <ul>{view.recent.map(({ match, opponent }) => <li key={match.id}>
        <Link className="touch-link" to={`/matches/${match.id}`}>{opponent.name}</Link>
        <span>{Number.isNaN(new Date(match.playedAt).getTime()) ? 'Unknown date' : formatDay(new Date(match.playedAt))}</span>
        <span>{STATUS_LABEL[match.status]}</span>
      </li>)}</ul>}
    </section>}
    <Link className="action-link floating-action" to="/matches/new">Start new match</Link>
  </section>;
}
