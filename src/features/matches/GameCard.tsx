import type { Game } from '../../domain/model';

export const metrics = [ ['netErrors', 'Net errors'], ['wideErrors', 'Wide errors'], ['longErrors', 'Long errors'], ['doubleFaults', 'Double faults'], ['failedReturns', 'Failed returns'] ] as const;

export default function GameCard({ game, onEdit, onDelete, disabled }: { game: Game; onEdit?: () => void; onDelete?: () => void; disabled?: boolean }) {
  return <article className="game-card" aria-label={`Game ${game.ordinal}`}>
    <h3>Game {game.ordinal}: <span>{game.result === 'won' ? 'Won' : 'Lost'}</span></h3>
    <p>{game.server === 'player' ? 'Player served' : 'Opponent served'}{game.score && ` · ${game.score.player}–${game.score.opponent}`}</p>
    <div className="metric-grid">{metrics.map(([key, label]) => <div className="metric" data-testid={`metric-${key}`} key={key}><span>{label}</span><strong>{game[key] === null ? <span aria-label="unknown">—</span> : game[key]}</strong></div>)}</div>
    {onEdit && <button type="button" disabled={disabled} onClick={onEdit}>Edit game {game.ordinal}</button>} {onDelete && <button type="button" disabled={disabled} onClick={onDelete}>Delete game {game.ordinal}</button>}
  </article>;
}
