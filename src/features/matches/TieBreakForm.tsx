import { useState } from 'react';
import type { TieBreakInput } from '../../application/matchService';
import type { TieBreakKind } from '../../domain/model';
import { metrics } from './GameCard';

export default function TieBreakForm({ setId, kind, busy, onSubmit }: { setId: string; kind: TieBreakKind; busy: boolean; onSubmit: (input: TieBreakInput) => Promise<void> }) {
  const [player, setPlayer] = useState(''); const [opponent, setOpponent] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  async function submit(e: React.FormEvent) {
    e.preventDefault(); if (busy) return;
    const counts = Object.fromEntries(metrics.slice(0, 4).map(([key]) => [key, values[key] ? Number(values[key]) : null]));
    if (!player || !opponent || [Number(player), Number(opponent), ...Object.values(counts).filter((n): n is number => n !== null)].some(n => !Number.isInteger(n) || n < 0)) { setError('Enter valid non-negative whole numbers for points and metrics.'); return; }
    setError(''); await onSubmit({ setId, kind, playerPoints: Number(player), opponentPoints: Number(opponent), netErrors: counts.netErrors, wideErrors: counts.wideErrors, longErrors: counts.longErrors, doubleFaults: counts.doubleFaults });
  }
  return <form onSubmit={submit} aria-label={`${kind === 'super' ? 'Super' : 'Standard'} tie-break`}><h2>{kind === 'super' ? 'Super' : 'Standard'} tie-break</h2>{error && <p role="alert">{error}</p>}
    <label>Player points<input type="number" min="0" step="1" required value={player} onChange={e => setPlayer(e.target.value)} /></label>
    <label>Opponent points<input type="number" min="0" step="1" required value={opponent} onChange={e => setOpponent(e.target.value)} /></label>
    {metrics.slice(0, 4).map(([key, label]) => <label key={key}>{label}<input type="number" min="0" step="1" value={values[key] ?? ''} onChange={e => setValues({ ...values, [key]: e.target.value })} /></label>)}
    <button type="submit" disabled={busy}>Complete tie-break</button>
  </form>;
}
