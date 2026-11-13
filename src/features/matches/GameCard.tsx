import type { Game, TieBreak } from '../../domain/model';
import { Pencil, Trash2 } from 'lucide-react';
import { effectiveUnforcedErrors } from '../../domain/statistics';
import IconLabel from '../../components/IconLabel';

export const metrics = [ ['netErrors', 'Net errors'], ['wideErrors', 'Wide errors'], ['longErrors', 'Long errors'], ['doubleFaults', 'Double faults'], ['failedReturns', 'Failed returns'] ] as const;
/** Tie-breaks record every metric except failed returns. */
export const tieBreakMetrics = metrics.slice(0, 4) as ReadonlyArray<readonly [keyof Pick<TieBreak, 'netErrors' | 'wideErrors' | 'longErrors' | 'doubleFaults'>, string]>;

/** Optional per-direction detail counts, shown inside the collapsed details of a game card and form. */
export const detailMetrics = [ ['netErrors', 'Net errors'], ['wideErrors', 'Wide errors'], ['longErrors', 'Long errors'] ] as const;

function Count({ value }: { value: number | null }) { return value === null ? <span aria-label="unknown">—</span> : <>{value}</>; }

export default function GameCard({ game, onEdit, onDelete, disabled }: { game: Game; onEdit?: () => void; onDelete?: () => void; disabled?: boolean }) {
  const unforced = effectiveUnforcedErrors(game);
  const derived = game.unforcedErrors === null && unforced !== null;
  const serveKey = game.server === 'player' ? 'doubleFaults' : 'failedReturns';
  const serveLabel = game.server === 'player' ? 'Double faults' : 'Receive errors';
  return <article className="game-card" aria-label={`Game ${game.ordinal}`}>
    <h3>Game {game.ordinal}: <span>{game.result === 'won' ? 'Won' : 'Lost'}</span></h3>
    <p>{game.server === 'player' ? 'Player served' : 'Opponent served'}{game.score && ` · ${game.score.player}–${game.score.opponent}`}</p>
    <div className="metric-grid">
      <div className="metric" data-testid="metric-unforcedErrors"><span>Unforced errors</span><strong><Count value={unforced} /></strong>{derived && <small>Derived from details</small>}</div>
      <div className="metric" data-testid={`metric-${serveKey}`}><span>{serveLabel}</span><strong><Count value={game[serveKey]} /></strong></div>
    </div>
    <details className="game-details"><summary>Details</summary>
      <div className="metric-grid">{detailMetrics.map(([key, label]) => <div className="metric" data-testid={`metric-${key}`} key={key}><span>{label}</span><strong><Count value={game[key]} /></strong></div>)}</div>
    </details>
    {game.comments && <p className="game-comment">{game.comments}</p>}
    {onEdit && <button type="button" aria-label={`Edit game ${game.ordinal}`} disabled={disabled} onClick={onEdit}><IconLabel icon={Pencil}>Edit</IconLabel></button>} {onDelete && <button type="button" aria-label={`Delete game ${game.ordinal}`} disabled={disabled} onClick={onDelete}><IconLabel icon={Trash2}>Delete</IconLabel></button>}
  </article>;
}
