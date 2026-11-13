import { useId, useRef, useState } from 'react';
import type { DraftGame, Server } from '../../domain/model';
import { GAME_COMMENT_MAX_LENGTH, normalizeGameComment } from '../../domain/validation';
import { Count, detailMetrics } from '../matches/GameCard';

type CountKey = 'unforcedErrors' | 'doubleFaults' | 'failedReturns' | (typeof detailMetrics)[number][0];
const COUNT_KEYS: readonly CountKey[] = ['unforcedErrors', 'doubleFaults', 'failedReturns', 'netErrors', 'wideErrors', 'longErrors'];
type Fields = Record<CountKey, string>;

function fieldsFor(game: DraftGame): Fields {
  return Object.fromEntries(COUNT_KEYS.map(key => [key, game[key] == null ? '' : String(game[key])])) as Fields;
}
const hasDetails = (game: DraftGame) => detailMetrics.some(([key]) => game[key] != null);
function invalid(value: string) {
  return value !== '' && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)));
}
const commentTooLong = (value: string) => value.trim().length > GAME_COMMENT_MAX_LENGTH;

/** Reviews one parsed voice game with the same simplified-first layout as manual entry: totals and comment first, details on demand. */
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
  const [comment, setComment] = useState(game.comments ?? '');
  const [result, setResult] = useState(game.result);
  const [server, setServer] = useState(game.server);
  const [detailsOpen, setDetailsOpen] = useState(() => hasDetails(game));
  const [validated, setValidated] = useState(false);
  const [error, setError] = useState(false);
  const [pending, setPending] = useState(false);
  const lock = useRef(false);
  const id = useId();
  const disabled = busy || pending;

  function reset() {
    setFields(fieldsFor(game));
    setComment(game.comments ?? '');
    setResult(game.result);
    setServer(game.server);
    setValidated(false);
    setError(false);
  }
  if (source !== signature) {
    setSource(signature);
    reset();
    if (hasDetails(game)) setDetailsOpen(true);
  }

  function edited() { onDirtyChange?.(index, true); }
  function changeServer(next: Server) {
    setServer(next);
    setFields(current => ({ ...current, [next === 'player' ? 'failedReturns' : 'doubleFaults']: '' }));
    edited();
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (disabled || lock.current) return;
    setValidated(true);
    const inapplicable: CountKey = server === 'player' ? 'failedReturns' : 'doubleFaults';
    const values = { ...fields, [inapplicable]: '' };
    if (detailMetrics.some(([key]) => invalid(values[key]))) setDetailsOpen(true);
    if (COUNT_KEYS.some(key => invalid(values[key])) || commentTooLong(comment)) return;
    const counts = Object.fromEntries(COUNT_KEYS.map(key => [key, values[key] === '' ? null : Number(values[key])])) as Pick<DraftGame, CountKey>;
    const patch: DraftGame = { server, result, ...counts, comments: normalizeGameComment(comment) };
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

  function metric(key: CountKey, label: string) {
    const value = fields[key];
    const hasError = validated && invalid(value);
    const errorId = `${id}-${key}-error`;
    return <div className="metric" key={key} data-testid={`draft-metric-${key}`}>
      <span>{label}</span><strong>{value === '' ? <Count value={null} /> : value}</strong>
      <label>{label}<input type="text" inputMode="numeric" value={value} disabled={disabled} aria-invalid={hasError || undefined} aria-describedby={hasError ? errorId : undefined} onChange={e => { setFields(current => ({ ...current, [key]: e.target.value })); edited(); }} /></label>
      {hasError && <span id={errorId}>Enter a non-negative whole number or leave blank.</span>}
    </div>;
  }

  const serveKey = server === 'player' ? 'doubleFaults' : 'failedReturns';
  const serveLabel = server === 'player' ? 'Double faults' : 'Receive errors';
  const commentError = validated && commentTooLong(comment);
  const commentErrorId = `${id}-comments-error`;
  return <form className="game-card draft-game-card" aria-label={`Draft game ${index + 1}`} onSubmit={submit} noValidate>
    <h3>Game {index + 1}</h3>
    {error && <p role="alert">Could not save this game. Please try again.</p>}
    <label>Result<select disabled={disabled} value={result} onChange={e => { setResult(e.target.value as DraftGame['result']); edited(); }}><option value="won">Won</option><option value="lost">Lost</option></select></label>
    <label>Server<select disabled={disabled} value={server} onChange={e => changeServer(e.target.value as Server)}><option value="player">Player served</option><option value="opponent">Opponent served</option></select></label>
    <div className="metric-grid">
      {metric('unforcedErrors', 'Unforced errors')}
      {metric(serveKey, serveLabel)}
    </div>
    <details className="game-form-details" open={detailsOpen} onToggle={e => setDetailsOpen(e.currentTarget.open)}><summary>Add details</summary>
      <div className="metric-grid">{detailMetrics.map(([key, label]) => metric(key, label))}</div>
    </details>
    <label>Game comment<textarea value={comment} disabled={disabled} aria-invalid={commentError || undefined} aria-describedby={commentError ? commentErrorId : undefined} onChange={e => { setComment(e.target.value); edited(); }} /></label>
    {commentError && <span id={commentErrorId}>Game comment must be at most {GAME_COMMENT_MAX_LENGTH} characters.</span>}
    <button disabled={disabled} type="submit">{pending ? 'Saving…' : `Save game ${index + 1}`}</button>
    <button disabled={disabled} type="button" onClick={() => { reset(); onDirtyChange?.(index, false); }}>Discard edits</button>
  </form>;
}
