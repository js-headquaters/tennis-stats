import { useState } from 'react';
import type { GameInput } from '../../application/matchService';
import type { Game, GameScore, Server } from '../../domain/model';
import { metrics } from './GameCard';

export default function GameForm({ server, game, busy, onSubmit, onCancel }: { server: Server; game?: Game; busy: boolean; onSubmit: (input: GameInput) => Promise<void>; onCancel?: () => void }) {
  const [result, setResult] = useState<Game['result']>(game?.result ?? 'won');
  const [serve, setServe] = useState<Server>(game?.server ?? server);
  const [values, setValues] = useState(() => Object.fromEntries(metrics.map(([key]) => [key, game?.[key]?.toString() ?? ''])));
  const [playerScore, setPlayerScore] = useState(game?.score?.player ?? '');
  const [opponentScore, setOpponentScore] = useState(game?.score?.opponent ?? '');
  const [error, setError] = useState('');
  async function submit(e: React.FormEvent) {
    e.preventDefault(); if (busy) return;
    if ((playerScore === '') !== (opponentScore === '')) { setError('Enter both scores or leave both blank.'); return; }
    if ((serve === 'player' && values.failedReturns !== '') || (serve === 'opponent' && values.doubleFaults !== '')) { setError('Double faults apply to player service; failed returns apply to opponent service.'); return; }
    const counts = Object.fromEntries(metrics.map(([key]) => [key, values[key] === '' ? null : Number(values[key])]));
    if (Object.values(counts).some(value => value !== null && (!Number.isInteger(value) || value < 0))) { setError('Metrics must be non-negative whole numbers.'); return; }
    setError('');
    await onSubmit({ server: serve, result, score: playerScore ? { player: playerScore as GameScore['player'], opponent: opponentScore as GameScore['opponent'] } : null, netErrors: counts.netErrors, wideErrors: counts.wideErrors, longErrors: counts.longErrors, doubleFaults: counts.doubleFaults, failedReturns: counts.failedReturns });
  }
  return <form onSubmit={submit} aria-label={game ? 'Edit game' : 'Manual game entry'}>
    <h3>{game ? 'Edit game' : 'Manual game entry'}</h3>{error && <p role="alert">{error}</p>}
    <label>Result<select value={result} onChange={e => setResult(e.target.value as Game['result'])}><option value="won">Won</option><option value="lost">Lost</option></select></label>
    <label>Server<select value={serve} onChange={e => setServe(e.target.value as Server)}><option value="player">Player served</option><option value="opponent">Opponent served</option></select></label>
    {(['Player', 'Opponent'] as const).map((label, i) => <label key={label}>{label} score<select value={i ? opponentScore : playerScore} onChange={e => i ? setOpponentScore(e.target.value as GameScore['opponent'] | '') : setPlayerScore(e.target.value as GameScore['player'] | '')}><option value="">Unknown</option>{['0', '15', '30', '40', 'AD'].map(v => <option key={v}>{v}</option>)}</select></label>)}
    {metrics.map(([key, label]) => <label key={key}>{label}<input type="number" min="0" step="1" value={values[key]} onChange={e => setValues({ ...values, [key]: e.target.value })} /></label>)}
    <button disabled={busy} type="submit">{game ? 'Save game' : 'Add game'}</button> {onCancel && <button disabled={busy} type="button" onClick={onCancel}>Cancel</button>}
  </form>;
}
