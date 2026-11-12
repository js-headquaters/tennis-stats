import { Link } from 'react-router-dom';
import { useEffect, useMemo, useState } from 'react';
import { dependencies } from '../../app/dependencies';
import type { MatchFilter, TennisRepository } from '../../application/ports';
import type { Match, MatchBundle, MatchFormat, MatchStatus, Opponent } from '../../domain/model';
import { evaluateMatch, evaluateSet } from '../../domain/scoring';
import { formatDay } from '../dashboard/periods';
import MatchFilters, { NO_FILTERS, type MatchFilterValue } from './MatchFilters';

export const FORMAT_LABEL: Record<MatchFormat, string> = {
  twoSetsSuperTiebreak: 'Two sets plus deciding super tie-break',
  openPractice: 'Open/practice match',
  oneSet: 'One set',
  bestOfThree: 'Best of three sets',
};
export const COMPLETION_LABEL: Record<MatchStatus, string> = { active: 'In progress (unfinished)', completed: 'Completed', abandoned: 'Abandoned (unfinished)' };

interface Row { match: Match; opponentName: string; bundle: MatchBundle | undefined | 'failed' }
interface Loaded { opponents: Opponent[]; rows: Row[] }

function parseDay(value: string): [number, number, number] | undefined {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return parts ? [Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])] : undefined;
}

/** Local-calendar day bounds as inclusive ISO instants (the end of `to` is the last millisecond of that day). */
export function toRepositoryFilter(value: MatchFilterValue): MatchFilter {
  const filter: MatchFilter = {};
  if (value.opponentId) filter.opponentId = value.opponentId;
  const from = parseDay(value.from); const to = parseDay(value.to);
  if (from) filter.from = new Date(from[0], from[1], from[2]).toISOString();
  if (to) filter.to = new Date(new Date(to[0], to[1], to[2] + 1).getTime() - 1).toISOString();
  return filter;
}

async function load(repository: TennisRepository, value: MatchFilterValue): Promise<Loaded> {
  const [opponents, matches] = await Promise.all([repository.listOpponents(), repository.listMatches(toRepositoryFilter(value))]);
  const names = new Map(opponents.map(opponent => [opponent.id, opponent.name]));
  const settled = await Promise.allSettled(matches.map(match => repository.getMatchBundle(match.id)));
  return { opponents, rows: matches.map((match, index) => {
    const result = settled[index];
    return { match, opponentName: (result.status === 'fulfilled' && result.value?.opponent.name) || names.get(match.opponentId) || 'Unknown opponent', bundle: result.status === 'fulfilled' ? result.value : 'failed' };
  }) };
}

function summarise(bundle: MatchBundle) {
  const sets = [...bundle.sets].sort((a, b) => a.ordinal - b.ordinal).map(set => {
    const tieBreak = bundle.tieBreaks.find(item => item.setId === set.id) ?? null;
    const evaluation = evaluateSet(bundle.games.filter(game => game.setId === set.id), tieBreak);
    const score = evaluation.kind === 'decidingSuperTiebreak' && tieBreak ? `${tieBreak.playerPoints}–${tieBreak.opponentPoints}` : `${evaluation.playerGames}–${evaluation.opponentGames}`;
    return { evaluation, score, hasData: evaluation.kind === 'decidingSuperTiebreak' ? tieBreak !== null : bundle.games.some(game => game.setId === set.id) };
  });
  const match = evaluateMatch(bundle.match.format, sets.map(set => set.evaluation));
  const verdict = match.winner === 'player' ? 'Won' : match.winner === 'opponent' ? 'Lost' : 'No result';
  const scores = sets.filter(set => set.hasData).map(set => set.score).join(', ');
  return { result: `${verdict}, sets ${match.playerSets}–${match.opponentSets}`, scores: scores || 'No games recorded' };
}

function dayLabel(playedAt: string) {
  const date = new Date(playedAt);
  return Number.isNaN(date.getTime()) ? 'Unknown date' : formatDay(date);
}

export default function MatchHistoryPage({ repository }: { repository?: TennisRepository }) {
  const [filters, setFilters] = useState<MatchFilterValue>(NO_FILTERS);
  const [opponents, setOpponents] = useState<Opponent[]>([]);
  const [data, setData] = useState<Row[]>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let owned: TennisRepository | undefined;
    void (async () => {
      try {
        const current = repository ?? (owned = await dependencies.openDatabase());
        if (cancelled) return;
        const loaded = await load(current, filters);
        if (!cancelled) { setOpponents(loaded.opponents); setData(loaded.rows); setFailed(false); }
      } catch { if (!cancelled) setFailed(true); }
      finally { owned?.close(); owned = undefined; }
    })();
    return () => { cancelled = true; };
  }, [repository, filters, attempt]);

  const unavailable = useMemo(() => data?.filter(row => row.bundle === 'failed').length ?? 0, [data]);
  const filtered = filters.opponentId !== '' || filters.from !== '' || filters.to !== '';

  return <section className="match-history"><h1>Matches</h1>
    <MatchFilters opponents={opponents} value={filters} onChange={setFilters} />
    {failed && <div><p role="alert">Unable to load matches.</p><button type="button" onClick={() => { setData(undefined); setAttempt(value => value + 1); }}>Retry</button></div>}
    {!failed && !data && <p>Loading matches…</p>}
    {!failed && data && unavailable > 0 && <div><p role="status">{unavailable === 1 ? '1 match result could not be loaded.' : `${unavailable} match results could not be loaded.`}</p><button type="button" onClick={() => setAttempt(value => value + 1)}>Retry loading results</button></div>}
    {!failed && data && (data.length === 0 ? <p>{filtered ? 'No matches match these filters.' : 'No matches recorded yet.'}</p> : <ul aria-label="Matches">
      {data.map(({ match, opponentName, bundle }) => {
        const summary = bundle && bundle !== 'failed' ? summarise(bundle) : undefined;
        return <li key={match.id}>
          <Link className="touch-link" to={`/matches/${match.id}`}>{opponentName}</Link>
          <span>{dayLabel(match.playedAt)}</span>
          <span>{COMPLETION_LABEL[match.status]}</span>
          <span>{FORMAT_LABEL[match.format]}</span>
          <span>{summary ? summary.result : 'Result unavailable'}</span>
          {summary && <span>{summary.scores}</span>}
        </li>;
      })}
    </ul>)}
  </section>;
}
