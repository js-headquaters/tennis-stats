import { useState } from 'react';
import type { TieBreakInput } from '../../application/matchService';
import type { TieBreak, TieBreakKind } from '../../domain/model';
import { tieBreakMetrics } from './GameCard';

/** Records a new tie-break, or corrects `tieBreak` when given (fields start from its stored values). */
export default function TieBreakForm({ setId, kind, busy, onSubmit, tieBreak, onCancel }: { setId: string; kind: TieBreakKind; busy: boolean; onSubmit: (input: TieBreakInput) => Promise<void>; tieBreak?: TieBreak; onCancel?: () => void }) {
  const [player, setPlayer] = useState(tieBreak?.playerPoints.toString() ?? ''); const [opponent, setOpponent] = useState(tieBreak?.opponentPoints.toString() ?? '');
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(tieBreakMetrics.map(([key]) => [key, tieBreak?.[key]?.toString() ?? ''])));
  const [error, setError] = useState('');
  const name = kind === 'super' ? 'super tie-break' : 'standard tie-break';
  const title = tieBreak ? `Edit ${name}` : name[0].toUpperCase() + name.slice(1);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); if (busy) return;
    const counts = Object.fromEntries(tieBreakMetrics.map(([key]) => [key, values[key] !== undefined && values[key] !== '' ? Number(values[key]) : null]));
    if (!player || !opponent || [Number(player), Number(opponent), ...Object.values(counts).filter((n): n is number => n !== null)].some(n => !Number.isInteger(n) || n < 0)) { setError('Enter valid non-negative whole numbers for points and metrics.'); return; }
    setError(''); await onSubmit({ setId, kind, playerPoints: Number(player), opponentPoints: Number(opponent), netErrors: counts.netErrors, wideErrors: counts.wideErrors, longErrors: counts.longErrors, doubleFaults: counts.doubleFaults });
  }
  return <form onSubmit={submit} aria-label={title}><h2>{title}</h2>{error && <p role="alert">{error}</p>}
    <label>Player points<input type="number" min="0" step="1" required value={player} onChange={e => setPlayer(e.target.value)} /></label>
    <label>Opponent points<input type="number" min="0" step="1" required value={opponent} onChange={e => setOpponent(e.target.value)} /></label>
    {tieBreakMetrics.map(([key, label]) => <label key={key}>{label}<input type="number" min="0" step="1" value={values[key] ?? ''} onChange={e => setValues({ ...values, [key]: e.target.value })} /></label>)}
    <button type="submit" disabled={busy}>{tieBreak ? 'Save tie-break' : 'Complete tie-break'}</button>{onCancel && <> <button type="button" disabled={busy} onClick={onCancel}>Cancel</button></>}
  </form>;
}
