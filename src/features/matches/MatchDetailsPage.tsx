import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { dependencies } from '../../app/dependencies';
import { deleteGame, updateComments, updateGame, updateMatchDetails, updateTieBreak, type CorrectionResult, type GameConflict, type MatchDetailsPatch, type MatchServiceDeps } from '../../application/matchService';
import type { Game, MatchBundle, TieBreak } from '../../domain/model';
import { evaluateStoredMatch } from '../../domain/scoring';
import { formatDay } from '../dashboard/periods';
import CorrectionConfirmation from './CorrectionConfirmation';
import GameForm from './GameForm';
import MatchAverages from './MatchAverages';
import { COMPLETION_LABEL, FORMAT_LABEL } from './MatchHistoryPage';
import MatchMetadataForm from './MatchMetadataForm';
import MatchSetDetails from './MatchSetDetails';
import TieBreakForm from './TieBreakForm';

type Correction = { conflicts: GameConflict[]; run: (confirmed: boolean) => Promise<CorrectionResult> };
type Editing = { kind: 'game'; game: Game } | { kind: 'tieBreak'; tieBreak: TieBreak };

function when(playedAt: string) {
  const date = new Date(playedAt);
  if (Number.isNaN(date.getTime())) return 'Unknown date';
  return `${formatDay(date)}, ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function result(bundle: MatchBundle) {
  const match = evaluateStoredMatch(bundle);
  return `${match.winner === 'player' ? 'Won' : match.winner === 'opponent' ? 'Lost' : 'No result'}, sets ${match.playerSets}–${match.opponentSets}`;
}

/** View and correct a stored match in place. Corrections never change `match.status`. */
export default function MatchDetailsPage({ deps }: { deps?: MatchServiceDeps }) {
  const { matchId = '' } = useParams();
  return <MatchDetailsContent key={matchId} matchId={matchId} deps={deps} />;
}

function MatchDetailsContent({ deps, matchId }: { deps?: MatchServiceDeps; matchId: string }) {
  const [services, setServices] = useState<MatchServiceDeps>(); const [bundle, setBundle] = useState<MatchBundle>();
  const [loading, setLoading] = useState(true); const [loadError, setLoadError] = useState(''); const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [busy, setBusy] = useState(false); const lock = useRef(false);
  const [comments, setComments] = useState(''); const [editing, setEditing] = useState<Editing>(); const [correction, setCorrection] = useState<Correction>();
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
    if (lock.current) return; lock.current = true; setBusy(true); setError(''); setNotice('');
    try { await work(); } catch (e) { setError(e instanceof Error ? e.message : 'Could not save the correction. Please try again.'); }
    finally { lock.current = false; setBusy(false); }
  }
  function applied(next: MatchBundle, message: string) { setBundle(next); setCorrection(undefined); setEditing(undefined); setNotice(message); }
  /** Task 7 flow: preview first; conflicting corrections wait for explicit confirmation. */
  function correct(operation: Correction['run'], message = 'Correction saved.') {
    return run(async () => { const outcome = await operation(false); if (outcome.conflicts.length) setCorrection({ conflicts: outcome.conflicts, run: operation }); else applied(outcome.bundle, message); });
  }

  if (loading) return <section className="match-details"><h1>Match</h1><p role="status">Loading match…</p></section>;
  if (loadError || !services) return <section className="match-details"><h1>Match</h1><p role="alert">Could not load match: {loadError}</p><button type="button" onClick={() => { setLoading(true); setLoadError(''); setAttempt(a => a + 1); }}>Retry</button> <Link className="touch-link" to="/matches">Back to matches</Link></section>;
  if (!bundle) return <section className="match-details"><h1>Match not found</h1><p>This match does not exist or was deleted.</p><Link className="touch-link" to="/matches">Back to matches</Link></section>;

  const blocked = busy || !!correction;
  const sets = [...bundle.sets].sort((a, b) => a.ordinal - b.ordinal);
  const slot = (setId: string) => (gameId: string | null) => {
    if (editing?.kind === 'game' && gameId === editing.game.id) return <GameForm key={editing.game.id} game={editing.game} server={editing.game.server} busy={blocked} onSubmit={input => correct(confirmed => updateGame(editing.game.id, input, services, confirmed))} onCancel={() => setEditing(undefined)} />;
    if (editing?.kind === 'tieBreak' && gameId === null && editing.tieBreak.setId === setId) {
      const tie = editing.tieBreak;
      return <TieBreakForm key={tie.id} setId={setId} kind={tie.kind} tieBreak={tie} busy={blocked} onSubmit={({ playerPoints, opponentPoints, netErrors, wideErrors, longErrors, doubleFaults }) => correct(confirmed => updateTieBreak(tie.id, { playerPoints, opponentPoints, netErrors, wideErrors, longErrors, doubleFaults }, services, confirmed))} onCancel={() => setEditing(undefined)} />;
    }
    return null;
  };

  return <section className="match-details live-match">
    <h1>Match against {bundle.opponent.name}</h1>
    <dl className="match-facts">
      <div><dt>Date</dt><dd>{when(bundle.match.playedAt)}</dd></div>
      <div><dt>Format</dt><dd>{FORMAT_LABEL[bundle.match.format]}</dd></div>
      <div><dt>Status</dt><dd>{COMPLETION_LABEL[bundle.match.status]}</dd></div>
      <div><dt>Result</dt><dd>{result(bundle)}</dd></div>
    </dl>
    <p><Link className="touch-link" to="/matches">Back to matches</Link>{bundle.match.status === 'active' && <> <Link className="touch-link" to={`/matches/${encodeURIComponent(bundle.match.id)}/live`}>Continue live match</Link></>}</p>
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {correction && <CorrectionConfirmation conflicts={correction.conflicts} busy={busy} onConfirm={() => void run(async () => applied((await correction.run(true)).bundle, 'Correction saved.'))} onCancel={() => setCorrection(undefined)} />}
    <MatchAverages games={bundle.games} />
    {sets.map(set => <MatchSetDetails key={set.id} bundle={bundle} set={set} disabled={blocked}
      onEditGame={game => setEditing({ kind: 'game', game })}
      onDeleteGame={game => void correct(confirmed => deleteGame(game.id, services, confirmed), `Game ${game.ordinal} deleted.`)}
      onEditTieBreak={tieBreak => setEditing({ kind: 'tieBreak', tieBreak })}>{slot(set.id)}</MatchSetDetails>)}
    <MatchMetadataForm key={`${bundle.match.opponentId}|${bundle.match.playedAt}|${bundle.match.format}`} bundle={bundle} busy={blocked} onSubmit={(patch: MatchDetailsPatch) => correct(confirmed => updateMatchDetails(bundle.match.id, patch, services, confirmed), 'Match details saved.')} />
    <form aria-label="Match comments" onSubmit={e => { e.preventDefault(); void run(async () => { setBundle(await updateComments(bundle.match.id, comments || null, services)); setNotice('Comments saved.'); }); }}>
      <label>Comments<textarea value={comments} onChange={e => setComments(e.target.value)} /></label><button type="submit" disabled={blocked}>Save comments</button>
    </form>
  </section>;
}
