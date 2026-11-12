import { useId, useRef, useState } from 'react';
import type { DraftGame, RecordedMetric, Server } from '../../domain/model';
import { metrics } from '../matches/GameCard';

type Fields = Record<RecordedMetric, string>;

function fieldsFor(game: DraftGame): Fields {
  return Object.fromEntries(metrics.map(([key]) => [key, game[key] === null ? '' : String(game[key])])) as Fields;
}

export default function DraftGameCard({ game, index, busy = false, onUpdate, onDirtyChange }: {
  game: DraftGame;
  index: number;
  busy?: boolean;
  onUpdate: (index: number, patch: Partial<DraftGame>) => Promise<unknown>;
  onDirtyChange?: (index: number, dirty: boolean) => void;
}) {
  const signature = JSON.stringify([index, game]);
  const [source, setSource] = useState(signature);
  const [fields, setFields] = useState(() => fieldsFor(game));
  const [result, setResult] = useState(game.result);
  const [server, setServer] = useState(game.server);
  const [validated, setValidated] = useState(false);
  const [error, setError] = useState(false);
  const [pending, setPending] = useState(false);
  const lock = useRef(false);
  const id = useId();

  if (source !== signature) {
    setSource(signature);
    setFields(fieldsFor(game));
    setResult(game.result);
    setServer(game.server);
    setValidated(false);
    setError(false);
  }

  function changeServer(next: Server) {
    setServer(next);
    setFields(current => ({ ...current, [next === 'player' ? 'failedReturns' : 'doubleFaults']: '' }));
    onDirtyChange?.(index, true);
  }

  function invalid(value: string) {
    return value !== '' && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || lock.current) return;
    setValidated(true);
    if (metrics.some(([key]) => invalid(fields[key]))) return;
    const values = Object.fromEntries(metrics.map(([key]) => [key, fields[key] === '' ? null : Number(fields[key])])) as Pick<DraftGame, RecordedMetric>;
    const patch = { ...values, server, result, ...(server === 'player' ? { failedReturns: null } : { doubleFaults: null }) };
    lock.current = true;
    setPending(true);
    setError(false);
    try {
      await onUpdate(index, patch);
      onDirtyChange?.(index, false);
    } catch {
      setError(true);
    } finally {
      lock.current = false;
      setPending(false);
    }
  }

  return <form className="game-card draft-game-card" aria-label={`Draft game ${index + 1}`} onSubmit={submit} noValidate>
    <h3>Game {index + 1}</h3>
    {error && <p role="alert">Could not save this game. Please try again.</p>}
    <label>Result<select disabled={busy || pending} value={result} onChange={e => { setResult(e.target.value as DraftGame['result']); onDirtyChange?.(index, true); }}><option value="won">Won</option><option value="lost">Lost</option></select></label>
    <label>Server<select disabled={busy || pending} value={server} onChange={e => changeServer(e.target.value as Server)}><option value="player">Player served</option><option value="opponent">Opponent served</option></select></label>
    <div className="metric-grid">{metrics.map(([key, label]) => {
      const inapplicable = (key === 'doubleFaults' && server !== 'player') || (key === 'failedReturns' && server !== 'opponent');
      const value = inapplicable ? '' : fields[key];
      const hasError = validated && invalid(value);
      const errorId = `${id}-${key}-error`;
      return <div className="metric" key={key} data-testid={`draft-metric-${key}`}>
        <span>{label}</span><strong>{value === '' ? <span aria-label="Unknown">—</span> : value}</strong>
        <label>{label}<input type="text" inputMode="numeric" value={value} disabled={busy || pending || inapplicable} aria-invalid={hasError || undefined} aria-describedby={hasError ? errorId : undefined} onChange={e => { setFields(current => ({ ...current, [key]: e.target.value })); onDirtyChange?.(index, true); }} /></label>
        {hasError && <span id={errorId}>Enter a non-negative whole number or leave blank.</span>}
      </div>;
    })}</div>
    <button disabled={busy || pending} type="submit">{pending ? 'Saving…' : `Save game ${index + 1}`}</button>
    <button disabled={busy || pending} type="button" onClick={() => { setFields(fieldsFor(game)); setServer(game.server); setResult(game.result); setError(false); setValidated(false); onDirtyChange?.(index, false); }}>Discard edits</button>
  </form>;
}
