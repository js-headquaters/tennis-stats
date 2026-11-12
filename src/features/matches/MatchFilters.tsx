import type { Opponent } from '../../domain/model';

export interface MatchFilterValue { opponentId: string; from: string; to: string }
export const NO_FILTERS: MatchFilterValue = { opponentId: '', from: '', to: '' };

/** Opponent and local-calendar date range controls; `from`/`to` are `YYYY-MM-DD` strings ('' = unbounded). */
export default function MatchFilters({ opponents, value, onChange }: { opponents: Opponent[]; value: MatchFilterValue; onChange: (next: MatchFilterValue) => void }) {
  const inverted = value.from !== '' && value.to !== '' && value.from > value.to;
  return <form className="match-filters" aria-label="Match filters" onSubmit={event => event.preventDefault()}>
    <p><label htmlFor="filter-opponent">Opponent</label>
      <select id="filter-opponent" value={value.opponentId} onChange={event => onChange({ ...value, opponentId: event.target.value })}>
        <option value="">All opponents</option>
        {opponents.map(opponent => <option key={opponent.id} value={opponent.id}>{opponent.name}</option>)}
      </select></p>
    <p><label htmlFor="filter-from">From date</label> <input id="filter-from" type="date" value={value.from} max={value.to || undefined} onChange={event => onChange({ ...value, from: event.target.value })} /></p>
    <p><label htmlFor="filter-to">To date</label> <input id="filter-to" type="date" value={value.to} min={value.from || undefined} onChange={event => onChange({ ...value, to: event.target.value })} /></p>
    {inverted && <p role="status">The start date is after the end date.</p>}
    {(value.opponentId || value.from || value.to) && <button type="button" onClick={() => onChange(NO_FILTERS)}>Clear filters</button>}
  </form>;
}
