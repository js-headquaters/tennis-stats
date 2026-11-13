import type { Game, TieBreak } from '../../domain/model';
import { Pencil, Trash2 } from 'lucide-react';
import IconLabel from '../../components/IconLabel';

export const metrics = [ ['netErrors', 'Net errors'], ['wideErrors', 'Wide errors'], ['longErrors', 'Long errors'], ['doubleFaults', 'Double faults'], ['failedReturns', 'Failed returns'] ] as const;
/** Tie-breaks record every metric except failed returns. */
export const tieBreakMetrics = metrics.slice(0, 4) as ReadonlyArray<readonly [keyof Pick<TieBreak, 'netErrors' | 'wideErrors' | 'longErrors' | 'doubleFaults'>, string]>;

export default function GameCard({ game, onEdit, onDelete, disabled }: { game: Game; onEdit?: () => void; onDelete?: () => void; disabled?: boolean }) {
  return <article className="game-card" aria-label={`Game ${game.ordinal}`}>
    <h3>Game {game.ordinal}: <span>{game.result === 'won' ? 'Won' : 'Lost'}</span></h3>
    <p>{game.server === 'player' ? 'Player served' : 'Opponent served'}{game.score && ` · ${game.score.player}–${game.score.opponent}`}</p>
    <div className="metric-grid">{metrics.map(([key, label]) => <div className="metric" data-testid={`metric-${key}`} key={key}><span>{label}</span><strong>{game[key] === null ? <span aria-label="unknown">—</span> : game[key]}</strong></div>)}</div>
    {onEdit && <button type="button" aria-label={`Edit game ${game.ordinal}`} disabled={disabled} onClick={onEdit}><IconLabel icon={Pencil}>Edit</IconLabel></button>} {onDelete && <button type="button" aria-label={`Delete game ${game.ordinal}`} disabled={disabled} onClick={onDelete}><IconLabel icon={Trash2}>Delete</IconLabel></button>}
  </article>;
}
