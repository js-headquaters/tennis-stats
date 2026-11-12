import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { dependencies } from '../../app/dependencies';
import type { TennisRepository } from '../../application/ports';
import type { VoiceDraft } from '../../domain/model';
import { evaluateSet } from '../../domain/scoring';
import type { AudioRecorder } from '../../infrastructure/audio/mediaRecorder';
import { useWorkHold } from '../../app/workGuard';
import ReadOnlyNotice from '../../components/ReadOnlyNotice';

type Service = { persistDraftFromAudio(input: { matchId: string; setId: string; audio: Blob; mimeType: string }): Promise<Pick<VoiceDraft, 'id' | 'state'>> };
type Scheduler = { schedule(action: () => void, delay: number): () => void };
const defaultScheduler: Scheduler = { schedule(action, delay) { const id = setTimeout(action, delay); return () => clearTimeout(id); } };
type Props = { repository?: TennisRepository; createRecorder?: () => AudioRecorder; createService?: (repository: TennisRepository) => Service; scheduler?: Scheduler };
type State = 'idle' | 'requesting-permission' | 'recording' | 'stopping' | 'saving' | 'error';
const draftLabels: Record<VoiceDraft['state'], string> = { recorded:'recorded, not yet processed', processing:'processing was interrupted', 'waiting-retry':'waiting to retry', ready:'ready for review', error:'needs attention', confirming:'confirmation was interrupted' };
/** A recording save that has not settled by then is reported as stuck (IndexedDB can leave a write pending, e.g. Blobs on WebKit). */
export const SAVE_TIMEOUT_MS = 10000;
type Audio = { blob: Blob; mimeType: string };
type PendingSave = { audio: Audio; promise: Promise<Pick<VoiceDraft, 'id' | 'state'>> };
const messages: Record<string, string> = { permission:'Microphone permission was denied or unavailable. Allow microphone access for this site in your browser or device settings, then try again, or use manual entry.', unsupported:'Audio recording or its format is not supported on this device.', empty:'The recording was empty. Please try again.', failed:'Recording failed. Please try again.', start:'Recording could not start. Please try again.', storage:'The recording could not be saved on this device. It is kept on this page; retry saving before leaving.', 'storage-timeout':'Saving the recording is taking too long. It is kept on this page; retry saving, or use manual entry.' };

function safeCode(reason: unknown) { try { const code = (reason as { code?: unknown })?.code; return typeof code === 'string' ? code : ''; } catch { return ''; /* Untrusted error. */ } }

export default function RecordPage(props: Props) {
  const { matchId = '' } = useParams();
  return <RecordContent key={matchId} {...props} matchId={matchId} />;
}
function RecordContent({ matchId, repository, createRecorder = dependencies.createRecorder, createService = dependencies.createDraftService, scheduler = defaultScheduler }: Props & { matchId: string }) {
  const navigate = useNavigate();
  const [loaded, setLoaded] = useState<{ repo: TennisRepository; setId: string }>();
  const [loading, setLoading] = useState(true); const [loadError, setLoadError] = useState(''); const [attempt, setAttempt] = useState(0);
  const [drafts, setDrafts] = useState<VoiceDraft[]>([]); const [listError, setListError] = useState(false);
  const [state, setState] = useState<State>('idle'); const [error, setError] = useState('');
  const [unsaved, setUnsavedState] = useState<Audio | null>(null); const unsavedRef = useRef<Audio | null>(null);
  function setUnsaved(audio: Audio | null) { unsavedRef.current = audio; setUnsavedState(audio); }
  // The one in-flight write of the unsaved audio: a retry re-awaits it instead of writing a duplicate draft.
  const saving = useRef<PendingSave | null>(null); const timedOut = useRef(false);
  // Unpersisted audio or an in-progress recording would be lost by a reload, so it blocks app updates.
  useWorkHold(state === 'requesting-permission' || state === 'recording' || state === 'stopping' || state === 'saving' || !!unsaved);
  const recorder = useRef<AudioRecorder | null>(null); const lock = useRef(false); const alive = useRef(true); const timer = useRef<(() => void) | undefined>(undefined); const generation = useRef(0);
  useEffect(() => {
    alive.current = true; let cancelled = false; let owned: TennisRepository | undefined;
    const close = () => { const current = owned; owned = undefined; current?.close(); };
    async function load() {
      try {
        const repo = repository ?? await dependencies.openDatabase(); if (!repository) owned = repo;
        if (cancelled) { close(); return; }
        const [bundle, retained] = await Promise.all([repo.getMatchBundle(matchId), repo.listDrafts(matchId).then(list => list, () => undefined)]);
        if (cancelled) return;
        setDrafts([...(retained ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt))); setListError(!retained);
        const set = bundle?.sets.find(item => item.status === 'active');
        if (!bundle || bundle.match.id !== matchId) { close(); setLoadError('Match not found.'); }
        else if (bundle.match.status !== 'active' || !set || set.matchId !== matchId || set.kind !== 'standard') { close(); setLoadError('No active standard set is available for recording.'); }
        else {
          const score = evaluateSet(bundle.games.filter(game => game.setId === set.id), bundle.tieBreaks.find(tie => tie.id === set.tieBreakId) ?? null);
          if (score.completed || (score.playerGames === 6 && score.opponentGames === 6)) { close(); setLoadError('No active standard set is available for recording.'); }
          else setLoaded({ repo, setId:set.id });
        }
        setLoading(false);
      } catch { close(); if (!cancelled) { setLoadError('Could not load match. Please try again.'); setLoading(false); } }
    }
    void load();
    return () => { cancelled = true; alive.current = false; generation.current++; timer.current?.(); void recorder.current?.cancel().catch(() => {}); recorder.current = null; close(); };
  }, [repository, matchId, attempt]);
  function showError(reason: unknown) {
    const code = safeCode(reason);
    setError(messages[code] ?? 'Recording or processing failed. Please try again. Previously saved recordings may still be available.'); setState('error');
  }
  const readOnly = loaded?.repo.getRecoveryStatus().mode === 'readOnly';
  async function start() {
    if (lock.current || !loaded || readOnly) return; lock.current = true; const token = ++generation.current; setError(''); setUnsaved(null); setState('requesting-permission');
    try {
      const current = createRecorder(); recorder.current = current; await current.start();
      if (!alive.current || token !== generation.current) return;
      setState('recording'); timer.current = scheduler.schedule(() => { void stop(); }, 120000);
    } catch (e) { if (alive.current && token === generation.current) showError(e); }
    finally { if (token === generation.current) lock.current = false; }
  }
  async function stop() {
    if (lock.current || !recorder.current || !loaded) return; lock.current = true; const token = generation.current; timer.current?.(); timer.current = undefined; setState('stopping');
    try {
      const audio = await recorder.current.stop();
      if (!alive.current || token !== generation.current) return;
      recorder.current = null;
      if (!audio.blob.size) { showError({ code:'empty' }); return; }
      setUnsaved(audio); await persist(audio, token);
    } catch (e) { if (alive.current && token === generation.current) showError(e); }
    finally { if (token === generation.current) lock.current = false; }
  }
  function opened(draft: Pick<VoiceDraft, 'id'>) { setUnsaved(null); navigate(`/voice/${encodeURIComponent(draft.id)}`); }
  async function persist(audio: Audio, token: number) {
    if (!loaded) return;
    setError(''); setState('saving'); timedOut.current = false;
    let pending = saving.current;
    if (!pending || pending.audio !== audio) {
      // Persist only; provider processing runs on the review page so an interruption never strands the audio.
      const entry: PendingSave = { audio, promise: createService(loaded.repo).persistDraftFromAudio({ matchId, setId:loaded.setId, audio:audio.blob, mimeType:audio.mimeType }) };
      saving.current = pending = entry;
      // A save that settles after the timeout still opens its draft, unless the audio was discarded meanwhile.
      entry.promise.then(draft => { if (saving.current !== entry) return; saving.current = null; if (alive.current && timedOut.current && unsavedRef.current === audio) opened(draft); }, () => { if (saving.current === entry) saving.current = null; });
    }
    let cancelTimer: (() => void) | undefined;
    const timeout = new Promise<never>((_, reject) => { cancelTimer = scheduler.schedule(() => reject({ code:'storage-timeout' }), SAVE_TIMEOUT_MS); });
    try {
      const draft = await Promise.race([pending.promise, timeout]);
      if (!alive.current || token !== generation.current) return;
      opened(draft);
    } catch (e) {
      if (safeCode(e) === 'storage-timeout' || timedOut.current) { timedOut.current = true; throw { code:'storage-timeout' }; }
      throw e;
    } finally { cancelTimer?.(); }
  }
  async function retrySave() {
    if (lock.current || !unsaved) return; lock.current = true; const token = ++generation.current;
    try { await persist(unsaved, token); }
    catch (e) { if (alive.current && token === generation.current) showError(e); }
    finally { if (token === generation.current) lock.current = false; }
  }
  async function cancel() {
    const token = ++generation.current; timer.current?.(); timer.current = undefined; const current = recorder.current; recorder.current = null; lock.current = false;
    try { await current?.cancel(); } catch { /* Cancellation remains safe. */ }
    if (alive.current && token === generation.current) { setError(''); setState('idle'); }
  }
  if (loading) return <section><h1>Record voice entry</h1><p role="status">Loading match…</p></section>;
  return <section className="record-page"><h1>Record voice entry</h1>
    {!!drafts.length && <><h2>Saved voice drafts</h2><ul>{drafts.map(draft => <li key={draft.id}><Link to={`/voice/${encodeURIComponent(draft.id)}`}>Resume draft from {draft.createdAt} — {draftLabels[draft.state] ?? 'needs attention'}</Link></li>)}</ul></>}
    {listError && <p>Saved drafts could not be listed. Recording is still available.</p>}
    {loadError ? <><p role="alert">{loadError}</p><button onClick={() => { setLoading(true); setLoadError(''); setLoaded(undefined); setAttempt(n => n + 1); }}>Retry</button></> : <>
      <p>Record up to two minutes. Recording stops automatically at the limit.</p>
      <p role="status" aria-live="polite">{({ idle:'Ready to record.', 'requesting-permission':'Requesting microphone permission…', recording:'Recording…', stopping:'Stopping recording…', saving:'Saving recording…', error:'Recording unavailable.' } as const)[state]}</p>
      {error && <p role="alert">{error}</p>}
      {readOnly && <ReadOnlyNotice disabled="recording is" />}
      {unsaved && state === 'error' && <><p>This recording has not been saved yet. Starting a new recording discards it.</p><button onClick={() => void retrySave()}>Retry saving recording</button></>}
      {(state === 'idle' || state === 'error') && <button disabled={readOnly} onClick={() => void start()}>Start recording</button>}
      {state === 'recording' && <button onClick={() => void stop()}>Stop recording</button>}
      {(state === 'requesting-permission' || state === 'recording' || state === 'stopping') && <button onClick={() => void cancel()}>Cancel recording</button>}
    </>}
    <p><Link to={`/matches/${encodeURIComponent(matchId)}/live`}>Manual entry</Link> <Link to="/settings">Settings</Link></p>
  </section>;
}
