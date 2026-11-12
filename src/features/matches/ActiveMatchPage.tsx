import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { dependencies } from '../../app/dependencies';
import { addGames, completeTieBreak, deleteGame, endSetEarly, finishMatch, nextGameServer, updateComments, updateGame, type GameConflict, type GameInput, type MatchServiceDeps, type TieBreakInput } from '../../application/matchService';
import type { Game, MatchBundle, MatchFormat } from '../../domain/model';
import { evaluateSet } from '../../domain/scoring';
import CorrectionConfirmation from './CorrectionConfirmation';
import GameCard from './GameCard';
import GameForm from './GameForm';
import TieBreakForm from './TieBreakForm';
import ReadOnlyNotice from '../../components/ReadOnlyNotice';
import { matchRecordPath } from '../../app/routes';

const formats: Record<MatchFormat, string> = { oneSet:'One set', bestOfThree:'Best of three sets', openPractice:'Open/practice match', twoSetsSuperTiebreak:'Two sets plus deciding super tie-break' };
type Correction = { conflicts: GameConflict[]; run: (confirmed: boolean) => ReturnType<typeof deleteGame> };
export default function ActiveMatchPage({ deps }: { deps?: MatchServiceDeps }) {
  const { matchId = '' } = useParams();
  return <ActiveMatchContent key={matchId} matchId={matchId} deps={deps} />;
}
function ActiveMatchContent({ deps, matchId }: { deps?: MatchServiceDeps; matchId: string }) {
  const [services, setServices] = useState<MatchServiceDeps>(); const [bundle, setBundle] = useState<MatchBundle>();
  const [loading, setLoading] = useState(true); const [loadError, setLoadError] = useState(''); const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const lock = useRef(false);
  const [comments, setComments] = useState(''); const [manual, setManual] = useState(false); const [editing, setEditing] = useState<Game>();
  const [correction, setCorrection] = useState<Correction>(); const [confirmAction, setConfirmAction] = useState<'end' | 'finish'>();
  useEffect(() => {
    let cancelled = false; let owned: MatchServiceDeps | undefined;
    function closeOwned() { const current = owned; owned = undefined; current?.repository.close(); }
    async function load() {
      try {
        const current = deps ?? { repository: await dependencies.openDatabase(), clock: dependencies.clock, ids: dependencies.ids };
        if (!deps) owned = current;
        if (cancelled) { closeOwned(); return; }
        const found = await current.repository.getMatchBundle(matchId);
        if (!cancelled) { setServices(current); setBundle(found); setComments(found?.match.comments ?? ''); setLoading(false); }
      } catch (e) { closeOwned(); if (!cancelled) { setLoadError(e instanceof Error ? e.message : 'Unable to load match'); setLoading(false); } }
    }
    void load(); return () => { cancelled = true; closeOwned(); };
  }, [deps, matchId, attempt]);
  async function run(work: () => Promise<void>) {
    if (lock.current) return; lock.current = true; setBusy(true); setError('');
    try { await work(); } catch (e) { setError(e instanceof Error ? e.message : 'Operation failed. Please try again.'); }
    finally { lock.current = false; setBusy(false); }
  }
  async function correct(operation: Correction['run']) {
    await run(async () => { const result = await operation(false); if (result.conflicts.length) setCorrection({ conflicts: result.conflicts, run: operation }); else { setBundle(result.bundle); setEditing(undefined); } });
  }
  if (loading || (bundle && bundle.match.id !== matchId)) return <section className="live-match-error"><h1>Live match</h1><p role="status">Loading match…</p></section>;
  if (loadError || !bundle || !services) return <section className="live-match-error"><h1>Live match</h1><p role="alert">{loadError ? `Could not load match: ${loadError}` : 'Match not found.'}</p><button onClick={() => { setLoading(true); setLoadError(''); setAttempt(a => a + 1); }}>Retry</button> <Link to="/matches">Matches</Link></section>;
  const active = bundle.sets.find(s => s.status === 'active');
  const ordered = [...bundle.games].sort((a,b) => (bundle.sets.find(s => s.id === a.setId)?.ordinal ?? 0) - (bundle.sets.find(s => s.id === b.setId)?.ordinal ?? 0) || a.ordinal - b.ordinal);
  const next = nextGameServer(bundle);
  const score = active && evaluateSet(bundle.games.filter(g => g.setId === active.id), bundle.tieBreaks.find(t => t.id === active.tieBreakId) ?? null);
  const tieKind = active?.kind === 'decidingSuperTiebreak' ? 'super' : score?.playerGames === 6 && score.opponentGames === 6 ? 'standard' : undefined;
  const isActive = bundle.match.status === 'active';
  // Read-only recovery mode: every write control is disabled and explained instead of failing on submit.
  const readOnly = services.repository.getRecoveryStatus().mode === 'readOnly';
  const locked = busy || !!correction || readOnly;
  const add = (input: GameInput) => run(async () => { setBundle(await addGames(bundle.match.id, [input], services)); setManual(false); });
  const tie = (input: TieBreakInput) => run(async () => { setBundle(await completeTieBreak(input, services)); });
  return <section className="live-match"><h1>Match against {bundle.opponent.name}</h1>
    <p>{new Date(bundle.match.playedAt).toLocaleString()} · {formats[bundle.match.format]} · Status: {bundle.match.status}</p>
    <h2>Sets</h2><ul>{bundle.sets.map(set => { const result = evaluateSet(bundle.games.filter(g => g.setId === set.id), bundle.tieBreaks.find(t => t.id === set.tieBreakId) ?? null); const tb = bundle.tieBreaks.find(t => t.id === set.tieBreakId); return <li key={set.id}>Set {set.ordinal}: {set.kind === 'decidingSuperTiebreak' ? `Super tie-break${tb ? ` ${tb.playerPoints}–${tb.opponentPoints}` : ''}` : `${result.playerGames}–${result.opponentGames}`} ({set.status})</li>; })}</ul>
    {isActive && active && <p>Next server: {next === 'player' ? 'Player' : 'Opponent'}</p>}
    {error && <p role="alert">{error}</p>}
    {readOnly && <ReadOnlyNotice disabled={isActive ? 'adding or editing games, recording and finishing the match are' : 'editing games and comments is'} />}
    <form onSubmit={e => { e.preventDefault(); void run(async () => { setBundle(await updateComments(bundle.match.id, comments || null, services)); }); }}><label>Comments<textarea value={comments} onChange={e => setComments(e.target.value)} /></label><button disabled={locked}>Save comments</button></form>
    {isActive && <div className="live-actions">{!readOnly && <Link className="action-link" to={matchRecordPath(bundle.match.id)}>Record with voice</Link>} <button disabled={locked || !active || !!tieKind} onClick={() => { setManual(!manual); setEditing(undefined); }}>Manual game entry</button></div>}
    {isActive && active && tieKind && <TieBreakForm key={active.id} setId={active.id} kind={tieKind} busy={locked} onSubmit={tie} />}
    {manual && active && !tieKind && <GameForm key={active.id} server={next} busy={locked} onSubmit={add} onCancel={() => setManual(false)} />}
    {editing && <GameForm key={editing.id} game={editing} server={editing.server} busy={locked} onSubmit={input => correct(confirmed => updateGame(editing.id, input, services, confirmed))} onCancel={() => setEditing(undefined)} />}
    {correction && <CorrectionConfirmation conflicts={correction.conflicts} busy={busy} onConfirm={() => void run(async () => { const result = await correction.run(true); setBundle(result.bundle); setCorrection(undefined); setEditing(undefined); })} onCancel={() => setCorrection(undefined)} />}
    <h2>Recent games</h2>{[...ordered].reverse().map(game => <GameCard key={game.id} game={game} disabled={locked} onEdit={() => { setManual(false); setEditing(game); }} onDelete={() => void correct(confirmed => deleteGame(game.id, services, confirmed))} />)}
    {isActive && <section><h2>Match actions</h2>{active && <button disabled={locked} onClick={() => setConfirmAction('end')}>End set early</button>} <button disabled={locked} onClick={() => setConfirmAction('finish')}>Finish match</button>{confirmAction && <section className="confirmation" aria-label="Confirm match action"><p>{confirmAction === 'end' ? 'End this set early?' : 'Finish this match?'}</p><button disabled={locked} onClick={() => void run(async () => { setBundle(confirmAction === 'end' && active ? await endSetEarly(active.id, services) : await finishMatch(bundle.match.id, services)); setConfirmAction(undefined); setManual(false); })}>Confirm {confirmAction === 'end' ? 'end set' : 'finish match'}</button> <button disabled={busy} onClick={() => setConfirmAction(undefined)}>Cancel</button></section>}</section>}
  </section>;
}
