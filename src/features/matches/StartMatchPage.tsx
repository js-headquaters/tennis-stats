import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { dependencies } from '../../app/dependencies';
import { abandonActiveMatch, startMatch, type MatchServiceDeps } from '../../application/matchService';
import type { MatchBundle, MatchFormat, Opponent, Server } from '../../domain/model';
import ReadOnlyNotice from '../../components/ReadOnlyNotice';

export function localDate(iso: string) {
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
export default function StartMatchPage({ deps }: { deps?: MatchServiceDeps }) {
  const navigate = useNavigate();
  const [services, setServices] = useState<MatchServiceDeps>();
  const [opponents, setOpponents] = useState<Opponent[]>([]);
  const [active, setActive] = useState<MatchBundle>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [name, setName] = useState('');
  const [date, setDate] = useState(() => localDate((deps?.clock ?? dependencies.clock).now()));
  const [format, setFormat] = useState<MatchFormat>('twoSetsSuperTiebreak');
  const [server, setServer] = useState<Server>('player');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let owned: MatchServiceDeps | undefined;
    async function load() {
      try {
        const current = deps ?? { repository: await dependencies.openDatabase(), clock: dependencies.clock, ids: dependencies.ids };
        if (!deps) owned = current;
        if (cancelled) { owned?.repository.close(); return; }
        const [list, match] = await Promise.all([current.repository.listOpponents(), current.repository.getActiveMatch()]);
        if (!cancelled) { setServices(current); setOpponents(list); setActive(match); setLoading(false); }
      } catch (e) { if (!cancelled) { setError(e instanceof Error ? e.message : 'Could not load matches'); setLoadFailed(true); setLoading(false); } }
    }
    void load();
    return () => { cancelled = true; owned?.repository.close(); };
  }, [deps, attempt]);
  const readOnly = services?.repository.getRecoveryStatus().mode === 'readOnly';
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (!services || busy || readOnly) return;
    setBusy(true); setError('');
    try {
      const bundle = await startMatch({ opponentName: name, playedAt: new Date(date).toISOString(), format, firstServer: server }, services);
      navigate(`/matches/${bundle.match.id}/live`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start match');
      try { setActive(await services.repository.getActiveMatch()); } catch { /* retain the original error */ }
    } finally { setBusy(false); }
  }
  async function abandon() {
    if (!services || !active || busy || readOnly) return;
    setBusy(true); setError('');
    try { await abandonActiveMatch(active.match.id, services); setActive(undefined); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not abandon match'); }
    finally { setBusy(false); }
  }
  return <section className="match-setup"><h1>New match</h1>
    {error && <p role="alert">{error}</p>}
    {readOnly && <ReadOnlyNotice disabled="starting or abandoning a match is" />}
    {loading ? <p>Loading matches…</p> : loadFailed ? <section aria-label="Loading failed"><p>Could not load match setup. Please try again.</p><button type="button" onClick={() => { setError(''); setLoadFailed(false); setLoading(true); setAttempt(value => value + 1); }}>Retry</button> <Link className="touch-link" to="/settings">Settings</Link></section> : active ? <section aria-label="Active match"><p>An active match exists. Complete or abandon it before starting another.</p><p>Against {active.opponent.name}</p><Link className="touch-link" to={`/matches/${active.match.id}/live`}>Resume match to complete it</Link> <button type="button" disabled={busy || readOnly} onClick={abandon}>Abandon active match</button></section> : <form onSubmit={submit}>
      <p><label htmlFor="opponent">Opponent</label> <input id="opponent" list="opponent-suggestions" value={name} onChange={e => setName(e.target.value)} required /><datalist id="opponent-suggestions">{opponents.filter(o => o.name.toLowerCase().includes(name.trim().toLowerCase())).map(o => <option key={o.id} value={o.name} />)}</datalist></p>
      <p><label htmlFor="playedAt">Date and time</label> <input id="playedAt" type="datetime-local" value={date} onChange={e => setDate(e.target.value)} required /></p>
      <p><label htmlFor="format">Format</label> <select id="format" value={format} onChange={e => setFormat(e.target.value as MatchFormat)}><option value="twoSetsSuperTiebreak">Two sets plus deciding super tie-break</option><option value="openPractice">Open/practice match with manual completion</option><option value="oneSet">One set</option><option value="bestOfThree">Best of three sets</option></select></p>
      <fieldset><legend>First server</legend><label className="radio-choice"><input type="radio" name="server" checked={server === 'player'} onChange={() => setServer('player')} /> Player serves first</label> <label className="radio-choice"><input type="radio" name="server" checked={server === 'opponent'} onChange={() => setServer('opponent')} /> Opponent serves first</label></fieldset>
      <button disabled={!services || busy || readOnly} type="submit">Start match</button>
    </form>}
  </section>;
}
