import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { dependencies } from '../../app/dependencies';
import type { TennisRepository } from '../../application/ports';
import type { DraftGame, VoiceDraft } from '../../domain/model';
import type { AudioRecorder } from '../../infrastructure/audio/mediaRecorder';
import DraftGameCard from './DraftGameCard';
import { useWorkHold } from '../../app/workGuard';
import ReadOnlyNotice from '../../components/ReadOnlyNotice';

type Service = ReturnType<typeof dependencies.createDraftService>;
type Scheduler = { schedule(action: () => void, delay: number): () => void };
const defaultScheduler: Scheduler = { schedule(action, delay) { const id = setTimeout(action, delay); return () => clearTimeout(id); } };
type Props = { repository?: TennisRepository; createService?: (repository: TennisRepository) => Pick<Service, 'retryDraft' | 'refineDraftWithAudio' | 'updateDraftGame' | 'confirmDraft'>; createRecorder?: () => AudioRecorder; scheduler?: Scheduler };
const providerMessages: Record<string, string> = { offline:'Waiting for an internet connection.', config:'Provider configuration is invalid.', auth:'Provider authentication failed.', rate:'Provider rate limit reached.', network:'Provider network request failed.', 'invalid-response':'Provider returned an invalid response.', cancelled:'Provider request was cancelled.' };
const recorderMessages: Record<string, string> = { permission:'Microphone permission was denied or unavailable. Allow microphone access for this site in your browser or device settings, then try again, or use manual entry.', unsupported:'Audio recording or its format is not supported on this device.', empty:'The recording was empty. Please try again.', failed:'Recording failed. Please try again.', start:'Recording could not start. Please try again.' };
function safeCode(error: unknown) { try { return typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : ''; } catch { return ''; } }
function messageFor(messages: Record<string, string>, code: string, fallback: string) { return Object.hasOwn(messages, code) ? messages[code] : fallback; }

export default function DraftReviewPage(props: Props) {
  const { draftId = '' } = useParams();
  return <ReviewContent key={draftId} {...props} draftId={draftId} />;
}
function ReviewContent({ draftId, repository, createService = dependencies.createDraftService, createRecorder = dependencies.createRecorder, scheduler = defaultScheduler }: Props & { draftId: string }) {
  const navigate = useNavigate();
  const [loaded, setLoaded] = useState<{ draft: VoiceDraft; repo: TennisRepository; service: ReturnType<NonNullable<Props['createService']>> }>();
  const [loading, setLoading] = useState(true); const [loadError, setLoadError] = useState(''); const [attempt, setAttempt] = useState(0);
  const [operation, setOperation] = useState(''); const [error, setError] = useState('');
  const [dirty, setDirty] = useState<Set<number>>(() => new Set()); const dirtyRef = useRef(new Set<number>());
  function dirtyChanged(index: number, value: boolean) { const next = new Set(dirtyRef.current); if (value) next.add(index); else next.delete(index); dirtyRef.current = next; setDirty(next); }
  // In-flight recording/processing/confirmation and unsaved game edits would be lost by a reload, so they block app updates.
  useWorkHold(!!operation || dirty.size > 0);
  const alive = useRef(true); const lock = useRef(false); const generation = useRef(0); const recorder = useRef<AudioRecorder | null>(null); const timer = useRef<(() => void) | undefined>(undefined); const abort = useRef<AbortController | null>(null);
  useEffect(() => {
    alive.current = true; let cancelled = false; let owned: TennisRepository | undefined;
    const close = () => { const repo = owned; owned = undefined; repo?.close(); };
    async function load() {
      try {
        const repo = repository ?? await dependencies.openDatabase(); if (!repository) owned = repo;
        if (cancelled) { close(); return; }
        const service = createService(repo); const draft = await repo.getDraft(draftId);
        if (cancelled) return;
        if (!draft) {
          try { const result = await service.confirmDraft(draftId); if (!cancelled) navigate(`/matches/${encodeURIComponent(result.bundle.match.id)}/live`, { replace:true }); }
          catch (e) {
            let missing = false;
            try { missing = safeCode(e) !== 'storage' && !(await repo.getDraftConfirmation(draftId)); } catch { /* Fail closed on storage errors. */ }
            if (!cancelled) { close(); setLoadError(missing ? 'Draft not found. Return to matches or try again.' : 'Could not load draft. Please try again.'); setLoading(false); }
          }
          return;
        }
        const bundle = await repo.getMatchBundle(draft.matchId);
        if (cancelled) return;
        if (!bundle || bundle.match.id !== draft.matchId) { close(); setLoadError('Could not load the match for this draft. Please try again.'); }
        else setLoaded({ draft, repo, service });
        setLoading(false);
      } catch { close(); if (!cancelled) { setLoadError('Could not load draft. Please try again.'); setLoading(false); } }
    }
    void load();
    return () => { cancelled = true; alive.current = false; generation.current++; timer.current?.(); abort.current?.abort(); void recorder.current?.cancel().catch(() => {}); recorder.current = null; close(); };
  }, [repository, createService, draftId, attempt, navigate]);
  // Read-only recovery mode: every draft write is refused, so recording, processing and confirming are disabled.
  const readOnly = loaded?.repo.getRecoveryStatus().mode === 'readOnly';
  function begin(name: string) { if (lock.current || !loaded || readOnly) return false; lock.current = true; setOperation(name); setError(''); return true; }
  function finish() { lock.current = false; setOperation(''); }
  async function refresh() { if (!loaded) return; try { const draft = await loaded.repo.getDraft(draftId); if (alive.current && draft) setLoaded({ ...loaded, draft }); } catch { /* Keep the last known persisted draft. */ } }
  async function update(index: number, patch: Partial<DraftGame>) {
    if (!loaded || !begin('saving')) throw new Error('Busy');
    try { const draft = await loaded.service.updateDraftGame(draftId, index, patch); if (alive.current) setLoaded({ ...loaded, draft }); }
    finally { if (alive.current) finish(); }
  }
  async function retry() {
    if (!loaded || dirtyRef.current.size || !begin('processing')) return; const controller = new AbortController(); abort.current = controller;
    try { const draft = await loaded.service.retryDraft(draftId, controller.signal); if (alive.current) setLoaded({ ...loaded, draft }); }
    catch { await refresh(); if (alive.current) setError('Could not retry the draft. Previously saved recordings may still be available.'); }
    finally { if (alive.current) finish(); }
  }
  async function confirm() {
    if (!loaded || dirtyRef.current.size || !begin('confirming')) return;
    try { const result = await loaded.service.confirmDraft(draftId); if (alive.current) navigate(`/matches/${encodeURIComponent(result.bundle.match.id)}/live`, { replace:true }); }
    catch { await refresh(); if (alive.current) setError('Could not confirm the draft. Please try again.'); }
    finally { if (alive.current) finish(); }
  }
  async function start() {
    if (!loaded || dirtyRef.current.size || !begin('requesting')) return; const token = ++generation.current;
    try { const current = createRecorder(); recorder.current = current; await current.start(); if (!alive.current || token !== generation.current) return; setOperation('recording'); timer.current = scheduler.schedule(() => { void stop(); }, 120000); }
    catch (e) { if (alive.current && token === generation.current) { setError(messageFor(recorderMessages, safeCode(e), 'Recording failed. Please try again.')); finish(); } }
  }
  async function stop() {
    if (!loaded || !recorder.current || operationRef.current !== 'recording') return; const token = generation.current; operationRef.current = 'stopping'; timer.current?.(); timer.current = undefined; setOperation('stopping');
    try { const audio = await recorder.current.stop(); if (!alive.current || token !== generation.current) return; recorder.current = null; if (!audio.blob.size) throw { code:'empty' }; setOperation('processing'); const controller = new AbortController(); abort.current = controller; const draft = await loaded.service.refineDraftWithAudio(draftId, { audio:audio.blob, mimeType:audio.mimeType }, controller.signal); if (alive.current && token === generation.current) setLoaded({ ...loaded, draft }); }
    catch (e) { await refresh(); if (alive.current && token === generation.current) setError(messageFor(recorderMessages, safeCode(e), 'Could not process recording. Previously saved recordings may still be available.')); }
    finally { if (alive.current && token === generation.current) finish(); }
  }
  const operationRef = useRef(operation); operationRef.current = operation;
  const autoProcessed = useRef(false);
  useEffect(() => {
    // A draft persisted straight from the recorder is processed here, so a reload or interruption leaves it retryable.
    // In read-only recovery mode the processing write would be refused, so the draft is left as it is.
    if (loaded?.draft.state !== 'recorded' || autoProcessed.current || readOnly) return;
    autoProcessed.current = true; void retry();
  }, [loaded, readOnly]);
  async function cancel() { const token = ++generation.current; timer.current?.(); timer.current = undefined; abort.current?.abort(); const current = recorder.current; recorder.current = null; try { await current?.cancel(); } catch { /* Safe cancellation. */ } if (alive.current && token === generation.current) { setError(''); finish(); } }
  const draft = loaded?.draft; const busy = !!operation;
  const state = operation === 'processing' ? 'Processing draft…' : operation === 'confirming' ? 'Confirming draft…' : operation === 'recording' ? 'Recording…' : operation === 'requesting' ? 'Requesting microphone permission…' : operation === 'stopping' ? 'Stopping recording…' : operation === 'saving' ? 'Saving game…' : draft?.state === 'waiting-retry' ? 'Waiting to retry.' : draft?.state === 'processing' ? 'Processing draft…' : draft?.state === 'confirming' ? 'Confirming draft…' : draft?.state === 'ready' ? 'Ready for review.' : 'Draft needs attention.';
  return <section className="draft-review"><h1>Voice draft</h1>
    {loading ? <p role="status">Loading draft…</p> : <>
      {loadError ? <><p role="alert">{loadError}</p><button onClick={() => { setLoading(true); setLoadError(''); setLoaded(undefined); setAttempt(n => n + 1); }}>Retry loading</button></> : draft && <>
        <p role="status" aria-live="polite">{state}</p>
        {draft.error && <p>{messageFor(providerMessages, draft.error.code, 'Draft processing failed. Please try again.')}</p>}
        {error && <p role="alert">{error}</p>}
        {readOnly && <ReadOnlyNotice disabled="recording, processing and confirming drafts are" />}
        <h2>Transcript history</h2>{draft.transcripts.length ? <ol>{draft.transcripts.map((item, index) => <li key={index}><p>{item.text}</p><p>Provider: {item.provider} · Model: {item.model}</p></li>)}</ol> : <p>No transcript yet.</p>}
        {!!draft.parsedDraft?.warnings.length && <><h2>Warnings</h2><ul>{draft.parsedDraft.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></>}
        {draft.parsedDraft && <><h2>Games</h2>{draft.parsedDraft.games.map((game, index) => <DraftGameCard key={index} game={game} index={index} busy={busy || readOnly || draft.state !== 'ready'} onUpdate={update} onDirtyChange={dirtyChanged} />)}</>}
        {!!dirty.size && <p>Save or discard your edits before continuing.</p>}
        {(draft.state === 'waiting-retry' || draft.state === 'error' || draft.state === 'recorded' || draft.state === 'processing') && <button disabled={busy || readOnly || !!dirty.size} onClick={() => void retry()}>Retry processing</button>}
        {draft.state === 'confirming' && <button disabled={busy || readOnly || !!dirty.size || !draft.parsedDraft?.games.length} onClick={() => void confirm()}>Resume confirmation</button>}
        <h2>Add or correct by voice</h2><p>Record up to two minutes. Recording stops automatically at the limit.</p>
        {!['requesting', 'recording', 'stopping'].includes(operation) && <button disabled={busy || readOnly || !!dirty.size} onClick={() => void start()}>Start recording</button>}
        {operation === 'recording' && <button onClick={() => void stop()}>Stop recording</button>}
        {['requesting', 'recording', 'stopping'].includes(operation) && <button onClick={() => void cancel()}>Cancel recording</button>}
        <p><button disabled={busy || readOnly || !!dirty.size || draft.state !== 'ready' || !draft.parsedDraft?.games.length} onClick={() => void confirm()}>Confirm and add</button></p>
      </>}
    </>}
    <p><Link to={draft ? `/matches/${encodeURIComponent(draft.matchId)}/live` : '/matches'}>Manual entry / live match</Link> <Link to="/settings">Settings</Link></p>
  </section>;
}
