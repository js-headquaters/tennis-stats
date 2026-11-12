import type { Game, MatchBundle, SetStatus, TennisSet, TieBreak } from '../../domain/model';
import { evaluateStoredSet, type SetEvaluation } from '../../domain/scoring';
import GameCard, { tieBreakMetrics } from './GameCard';

const SET_STATUS: Record<SetStatus, string> = { completed: 'Set completed', unfinished: 'Set unfinished', active: 'Set in progress' };
const setStatusLabel = (set: TennisSet, evaluation: SetEvaluation) => set.status === 'completed' && !evaluation.completed ? 'Recorded as completed — score no longer decides the set' : SET_STATUS[set.status];
const verdict = (winner: SetEvaluation['winner']) => winner === 'player' ? 'Won' : winner === 'opponent' ? 'Lost' : 'No result';

function TieBreakSummary({ tieBreak, disabled, onEdit }: { tieBreak: TieBreak; disabled: boolean; onEdit: () => void }) {
  const title = tieBreak.kind === 'super' ? 'Super tie-break' : 'Standard tie-break';
  const winner = tieBreak.playerPoints > tieBreak.opponentPoints ? 'player' : tieBreak.playerPoints < tieBreak.opponentPoints ? 'opponent' : null;
  return <section role="region" aria-label={title} className="game-card"><h3>{title}</h3>
    <p>Points {tieBreak.playerPoints}–{tieBreak.opponentPoints} · {verdict(winner)}</p>
    <div className="metric-grid">{tieBreakMetrics.map(([key, label]) => <div className="metric" data-testid={`metric-${key}`} key={key}><span>{label}</span><strong>{tieBreak[key] === null ? <span aria-label="unknown">—</span> : tieBreak[key]}</strong></div>)}</div>
    <button type="button" disabled={disabled} onClick={onEdit}>Edit tie-break</button>
  </section>;
}

export default function MatchSetDetails({ bundle, set, disabled, onEditGame, onDeleteGame, onEditTieBreak, children }: { bundle: MatchBundle; set: TennisSet; disabled: boolean; onEditGame: (game: Game) => void; onDeleteGame: (game: Game) => void; onEditTieBreak: (tieBreak: TieBreak) => void; children?: (gameId: string | null) => React.ReactNode }) {
  const evaluation = evaluateStoredSet(bundle, set);
  const tieBreak = bundle.tieBreaks.find(t => t.id === set.tieBreakId);
  const games = bundle.games.filter(game => game.setId === set.id).sort((a, b) => a.ordinal - b.ordinal);
  const score = set.kind === 'decidingSuperTiebreak' ? (tieBreak ? `${tieBreak.playerPoints}–${tieBreak.opponentPoints}` : 'No points recorded') : `${evaluation.playerGames}–${evaluation.opponentGames}`;
  return <section role="region" aria-label={`Set ${set.ordinal}`} className="match-set">
    <h2>Set {set.ordinal}{set.kind === 'decidingSuperTiebreak' && ': deciding super tie-break'}</h2>
    <p className="set-summary">Score {score} · {verdict(evaluation.winner)} · {setStatusLabel(set, evaluation)}</p>
    {tieBreak && <TieBreakSummary tieBreak={tieBreak} disabled={disabled} onEdit={() => onEditTieBreak(tieBreak)} />}
    {children?.(null)}
    {set.kind === 'standard' && games.length === 0 && <p>No games recorded.</p>}
    {games.map(game => <div key={game.id}><GameCard game={game} disabled={disabled} onEdit={() => onEditGame(game)} onDelete={() => onDeleteGame(game)} />{children?.(game.id)}</div>)}
  </section>;
}
