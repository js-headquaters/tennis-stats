import { useState } from 'react';
import type { GameInput } from '../../application/matchService';
import type { Game, GameScore, Server } from '../../domain/model';
import { GAME_COMMENT_MAX_LENGTH, normalizeGameComment } from '../../domain/validation';
import { detailMetrics } from './GameCard';

type CountKey = 'unforcedErrors' | 'doubleFaults' | 'failedReturns' | (typeof detailMetrics)[number][0];
const COUNT_KEYS: readonly CountKey[] = ['unforcedErrors', 'doubleFaults', 'failedReturns', 'netErrors', 'wideErrors', 'longErrors'];

export default function GameForm({ server, game, busy, onSubmit, onCancel }: { server: Server; game?: Game; busy: boolean; onSubmit: (input: GameInput) => Promise<void>; onCancel?: () => void }) {
  const [result, setResult] = useState<Game['result']>(game?.result ?? 'won');
  const [serve, setServe] = useState<Server>(game?.server ?? server);
  const [values, setValues] = useState<Record<CountKey, string>>(() => Object.fromEntries(COUNT_KEYS.map(key => [key, game?.[key]?.toString() ?? ''])) as Record<CountKey, string>);
  const [comment, setComment] = useState(game?.comments ?? '');
  const [playerScore, setPlayerScore] = useState(game?.score?.player ?? '');
  const [opponentScore, setOpponentScore] = useState(game?.score?.opponent ?? '');
  const [error, setError] = useState('');
  const hasDetails = detailMetrics.some(([key]) => game?.[key] != null);
  const serveKey = serve === 'player' ? 'doubleFaults' : 'failedReturns';
  const serveLabel = serve === 'player' ? 'Double faults' : 'Receive errors';
  function changeServer(next: Server) {
    setServe(next);
    setValues(current => ({ ...current, [next === 'player' ? 'failedReturns' : 'doubleFaults']: '' }));
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault(); if (busy) return;
    if ((playerScore === '') !== (opponentScore === '')) { setError('Enter both scores or leave both blank.'); return; }
    const counts = Object.fromEntries(COUNT_KEYS.map(key => [key, key === 'doubleFaults' && serve === 'opponent' || key === 'failedReturns' && serve === 'player' || values[key] === '' ? null : Number(values[key])])) as Record<CountKey, number | null>;
    if (Object.values(counts).some(value => value !== null && (!Number.isInteger(value) || value < 0))) { setError('Counts must be non-negative whole numbers.'); return; }
    if (comment.length > GAME_COMMENT_MAX_LENGTH) { setError(`Game comment must be at most ${GAME_COMMENT_MAX_LENGTH} characters.`); return; }
    setError('');
    await onSubmit({ server: serve, result, score: playerScore ? { player: playerScore as GameScore['player'], opponent: opponentScore as GameScore['opponent'] } : null, ...counts, comments: normalizeGameComment(comment) });
  }
  const numberInput = (key: CountKey, label: string) => <label key={key}>{label}<input type="number" inputMode="numeric" min="0" step="1" value={values[key]} onChange={e => setValues({ ...values, [key]: e.target.value })} /></label>;
  return <form onSubmit={submit} aria-label={game ? 'Edit game' : 'Manual game entry'}>
    <h3>{game ? 'Edit game' : 'Manual game entry'}</h3>{error && <p role="alert">{error}</p>}
    <label>Result<select value={result} onChange={e => setResult(e.target.value as Game['result'])}><option value="won">Won</option><option value="lost">Lost</option></select></label>
    <label>Server<select value={serve} onChange={e => changeServer(e.target.value as Server)}><option value="player">Player served</option><option value="opponent">Opponent served</option></select></label>
    {(['Player', 'Opponent'] as const).map((label, i) => <label key={label}>{label} score<select value={i ? opponentScore : playerScore} onChange={e => i ? setOpponentScore(e.target.value as GameScore['opponent'] | '') : setPlayerScore(e.target.value as GameScore['player'] | '')}><option value="">Unknown</option>{['0', '15', '30', '40', 'AD'].map(v => <option key={v}>{v}</option>)}</select></label>)}
    {numberInput('unforcedErrors', 'Unforced errors')}
    {numberInput(serveKey, serveLabel)}
    <details className="game-form-details" open={hasDetails || undefined}><summary>Add details</summary>
      {detailMetrics.map(([key, label]) => numberInput(key, label))}
    </details>
    <label>Game comment<textarea value={comment} maxLength={GAME_COMMENT_MAX_LENGTH} onChange={e => setComment(e.target.value)} /></label>
    <button disabled={busy} type="submit">{game ? 'Save game' : 'Add game'}</button> {onCancel && <button disabled={busy} type="button" onClick={onCancel}>Cancel</button>}
  </form>;
}
