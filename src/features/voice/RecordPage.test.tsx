import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import type { TennisRepository } from '../../application/ports';
import type { MatchBundle, VoiceDraft } from '../../domain/model';
import { createDraftService } from '../../application/draftService';
import RecordPage, { SAVE_TIMEOUT_MS } from './RecordPage';
import { dependencies } from '../../app/dependencies';
import { workRegistry } from '../../app/workGuard';

const now = '2026-01-01T00:00:00Z';
const bundle: MatchBundle = { opponent:{ id:'o', name:'Alex', normalizedName:'alex', createdAt:now, updatedAt:now }, match:{ id:'m', opponentId:'o', playedAt:now, format:'oneSet', firstServer:'player', status:'active', comments:null, createdAt:now, updatedAt:now }, sets:[{ id:'s', matchId:'m', ordinal:1, kind:'standard', status:'active', tieBreakId:null, createdAt:now, updatedAt:now }], games:[], tieBreaks:[] };
function setup() {
  const repository = { getMatchBundle:vi.fn().mockResolvedValue(bundle), listDrafts:vi.fn().mockResolvedValue([]), close:vi.fn(), getRecoveryStatus:() => ({ mode:'normal' }) } as unknown as TennisRepository;
  const recorder = { start:vi.fn().mockResolvedValue(undefined), stop:vi.fn().mockResolvedValue({ blob:new Blob(['audio'], { type:'audio/webm' }), mimeType:'audio/webm' }), cancel:vi.fn().mockResolvedValue(undefined) };
  const service = { persistDraftFromAudio:vi.fn().mockResolvedValue({ id:'d', state:'recorded' }) };
  const view = render(<MemoryRouter initialEntries={['/matches/m/record']}><Routes><Route path="/matches/:matchId/record" element={<RecordPage repository={repository} createRecorder={() => recorder} createService={() => service} />} /><Route path="/voice/:draftId" element={<p>Draft review</p>} /></Routes></MemoryRouter>);
  return { repository, recorder, service, view };
}
it('does nothing until start and navigates after stopping a recording', async () => {
  const { recorder, service } = setup();
  const start = await screen.findByRole('button', { name:'Start recording' });
  expect(start).toHaveTextContent(/^Record$/);
  expect(start.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  expect(recorder.start).not.toHaveBeenCalled(); expect(service.persistDraftFromAudio).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name:'Start recording' }));
  fireEvent.click(await screen.findByRole('button', { name:'Stop recording' }));
  expect(await screen.findByText('Draft review')).toBeInTheDocument();
  expect(service.persistDraftFromAudio).toHaveBeenCalledTimes(1);
});
it('shows a safe failure and manual fallback when permission fails', async () => {
  const { recorder } = setup(); recorder.start.mockRejectedValue({ code:'permission', message:'secret-sentinel' });
  fireEvent.click(await screen.findByRole('button', { name:'Start recording' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/microphone/i);
  expect(document.body).not.toHaveTextContent('secret-sentinel');
  expect(screen.getByRole('link', { name:/manual entry/i })).toHaveAttribute('href', '/matches/m/live');
});
it('cancels without submitting and does not close an injected repository', async () => {
  const { recorder, repository, service, view } = setup();
  fireEvent.click(await screen.findByRole('button', { name:'Start recording' }));
  fireEvent.click(await screen.findByRole('button', { name:'Cancel recording' }));
  await waitFor(() => expect(recorder.cancel).toHaveBeenCalled());
  expect(await screen.findByRole('button', { name:'Start recording' })).toBeInTheDocument();
  expect(service.persistDraftFromAudio).not.toHaveBeenCalled(); view.unmount(); expect(repository.close).not.toHaveBeenCalled();
});
function memoryRepository() {
  const drafts = new Map<string, VoiceDraft>();
  return { drafts, repository: {
    getMatchBundle:vi.fn().mockResolvedValue(bundle), close:vi.fn(), getRecoveryStatus:() => ({ mode:'normal' }),
    saveDraft:vi.fn(async (draft: VoiceDraft) => { drafts.set(draft.id, draft); }), getDraft:vi.fn(async (id: string) => drafts.get(id)),
    listDrafts:vi.fn(async (matchId?: string) => [...drafts.values()].filter(draft => !matchId || draft.matchId === matchId)),
  } as unknown as TennisRepository };
}
function realService(repository: TennisRepository) {
  let n = 0; const transcriber = { transcribe:vi.fn() }; const parser = { parse:vi.fn() };
  return { transcriber, parser, create: () => createDraftService({ repository, transcriber, parser, clock:{ now:() => now }, ids:{ next:() => `id-${++n}` }, isOnline:() => true }) };
}
function renderRecord(repository: TennisRepository, createService: (repo: TennisRepository) => Pick<ReturnType<typeof createDraftService>, 'persistDraftFromAudio'>, recorder = { start:vi.fn().mockResolvedValue(undefined), stop:vi.fn().mockResolvedValue({ blob:new Blob(['audio']), mimeType:'audio/mp4' }), cancel:vi.fn().mockResolvedValue(undefined) }) {
  return render(<MemoryRouter initialEntries={['/matches/m/record']}><Routes><Route path="/matches/:matchId/record" element={<RecordPage repository={repository} createRecorder={() => recorder} createService={createService} />} /><Route path="/voice/:draftId" element={<p>Draft review</p>} /></Routes></MemoryRouter>);
}
it('persists the recording and navigates to its review page immediately, without calling providers', async () => {
  const { repository, drafts } = memoryRepository(); const service = realService(repository);
  renderRecord(repository, service.create);
  fireEvent.click(await screen.findByRole('button', { name:'Start recording' }));
  fireEvent.click(await screen.findByRole('button', { name:'Stop recording' }));
  expect(await screen.findByText('Draft review')).toBeInTheDocument();
  expect([...drafts.values()]).toEqual([expect.objectContaining({ matchId:'m', setId:'s', state:'recorded', mimeType:'audio/mp4' })]);
  expect(service.transcriber.transcribe).not.toHaveBeenCalled(); expect(service.parser.parse).not.toHaveBeenCalled();
});
it('leaves a discoverable draft when interrupted after recording, listed on revisit', async () => {
  const { repository, drafts } = memoryRepository(); const service = realService(repository);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const view = renderRecord(repository, repo => { const inner = service.create(); return { persistDraftFromAudio: async input => { const draft = await inner.persistDraftFromAudio(input); await gate; return draft; } }; void repo; });
  fireEvent.click(await screen.findByRole('button', { name:'Start recording' }));
  fireEvent.click(await screen.findByRole('button', { name:'Stop recording' }));
  await waitFor(() => expect(drafts.size).toBe(1)); view.unmount(); release();
  renderRecord(repository, service.create);
  const [saved] = [...drafts.values()];
  expect(await screen.findByRole('link', { name:/resume.*recorded/i })).toHaveAttribute('href', `/voice/${saved.id}`);
  expect(service.transcriber.transcribe).not.toHaveBeenCalled();
});
it('keeps recording available when retained drafts cannot be listed', async () => {
  const { repository } = memoryRepository(); vi.mocked(repository.listDrafts).mockRejectedValue(new Error('secret-sentinel'));
  renderRecord(repository, realService(repository).create);
  expect(await screen.findByRole('button', { name:'Start recording' })).toBeInTheDocument();
  expect(screen.getByText(/saved drafts could not be listed/i)).toBeInTheDocument(); expect(document.body).not.toHaveTextContent('secret-sentinel');
});
it('shows a safe message and stays on the page when the recording cannot be saved', async () => {
  const { service } = setup(); service.persistDraftFromAudio.mockRejectedValue(new Error('secret-sentinel'));
  fireEvent.click(await screen.findByRole('button', { name:'Start recording' }));
  fireEvent.click(await screen.findByRole('button', { name:'Stop recording' }));
  expect(await screen.findByRole('alert')).toBeInTheDocument(); expect(document.body).not.toHaveTextContent('secret-sentinel');
  expect(screen.queryByText('Draft review')).not.toBeInTheDocument(); expect(screen.getByRole('button', { name:'Start recording' })).toBeInTheDocument();
});
it('keeps the unsaved recording in memory and retries saving the same audio', async () => {
  const { service, recorder } = setup(); service.persistDraftFromAudio.mockRejectedValueOnce({ code:'storage' });
  fireEvent.click(await screen.findByRole('button', { name:'Start recording' }));
  fireEvent.click(await screen.findByRole('button', { name:'Stop recording' }));
  const retry = await screen.findByRole('button', { name:'Retry saving recording' });
  expect(retry).toHaveTextContent(/^Retry saving$/);
  fireEvent.click(retry);
  expect(await screen.findByText('Draft review')).toBeInTheDocument();
  expect(recorder.stop).toHaveBeenCalledTimes(1); expect(service.persistDraftFromAudio).toHaveBeenCalledTimes(2);
  expect(service.persistDraftFromAudio.mock.calls[1][0].audio).toBe(service.persistDraftFromAudio.mock.calls[0][0].audio);
});
it.each(['unsupported', 'empty', 'failed'])('shows a safe %s recorder failure and manual entry', async code => {
  const { recorder } = setup(); recorder.stop.mockRejectedValue({ code, message:'secret-sentinel' });
  fireEvent.click(await screen.findByRole('button', { name:'Start recording' }));
  fireEvent.click(await screen.findByRole('button', { name:'Stop recording' }));
  expect(await screen.findByRole('alert')).toBeInTheDocument(); expect(document.body).not.toHaveTextContent('secret-sentinel');
  expect(screen.getByRole('link', { name:/manual entry/i })).toBeInTheDocument();
});
it('locks duplicate starts and stops while asynchronous work is pending', async () => {
  const { recorder, service } = setup(); let started!: () => void; let stopped!: (value: { blob: Blob; mimeType: string }) => void;
  recorder.start.mockReturnValue(new Promise<void>(resolve => { started = resolve; }));
  recorder.stop.mockReturnValue(new Promise(resolve => { stopped = resolve; }));
  const start = await screen.findByRole('button', { name:'Start recording' }); fireEvent.click(start); fireEvent.click(start);
  expect(recorder.start).toHaveBeenCalledTimes(1); expect(screen.getByRole('status')).toHaveTextContent(/permission/i);
  await act(async () => started()); const stop = await screen.findByRole('button', { name:'Stop recording' }); fireEvent.click(stop); fireEvent.click(stop);
  expect(recorder.stop).toHaveBeenCalledTimes(1); expect(screen.getByRole('status')).toHaveTextContent(/stopping/i);
  await act(async () => stopped({ blob:new Blob(['x']), mimeType:'audio/webm' }));
  await screen.findByText('Draft review'); expect(service.persistDraftFromAudio).toHaveBeenCalledTimes(1);
});
it('closes owned repositories on failure and retry, and sanitizes load errors', async () => {
  const failed = { getMatchBundle:vi.fn().mockRejectedValue(new Error('secret-sentinel')), listDrafts:vi.fn().mockResolvedValue([]), close:vi.fn() };
  const success = { getMatchBundle:vi.fn().mockResolvedValue(bundle), listDrafts:vi.fn().mockResolvedValue([]), close:vi.fn(), getRecoveryStatus:() => ({ mode:'normal' as const }) };
  const open = vi.spyOn(dependencies, 'openDatabase').mockResolvedValueOnce(failed as never).mockResolvedValueOnce(success as never);
  const view = render(<MemoryRouter initialEntries={['/matches/m/record']}><Routes><Route path="/matches/:matchId/record" element={<RecordPage />} /></Routes></MemoryRouter>);
  await screen.findByRole('alert'); expect(document.body).not.toHaveTextContent('secret-sentinel'); expect(failed.close).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('link', { name:/manual entry/i })).toBeInTheDocument(); fireEvent.click(screen.getByRole('button', { name:'Retry' }));
  await screen.findByRole('button', { name:'Start recording' }); view.unmount(); expect(success.close).toHaveBeenCalledTimes(1); expect(failed.close).toHaveBeenCalledTimes(1); open.mockRestore();
});
it('releases an active recorder on unmount', async () => {
  const { recorder, view } = setup(); fireEvent.click(await screen.findByRole('button', { name:'Start recording' }));
  await screen.findByRole('button', { name:'Stop recording' }); view.unmount(); expect(recorder.cancel).toHaveBeenCalledTimes(1);
});
it('automatically stops at the stated limit with an injected scheduler', async () => {
  let deadline!: () => void; const clear = vi.fn(); const scheduler = { schedule:vi.fn((action: () => void) => { deadline = action; return clear; }) };
  const repository = { getMatchBundle:vi.fn().mockResolvedValue(bundle), listDrafts:vi.fn().mockResolvedValue([]), close:vi.fn(), getRecoveryStatus:() => ({ mode:'normal' }) } as unknown as TennisRepository;
  const recorder = { start:vi.fn().mockResolvedValue(undefined), stop:vi.fn().mockResolvedValue({ blob:new Blob(['x']), mimeType:'audio/webm' }), cancel:vi.fn().mockResolvedValue(undefined) };
  const service = { persistDraftFromAudio:vi.fn().mockResolvedValue({ id:'d', state:'recorded' }) };
  render(<MemoryRouter initialEntries={['/matches/m/record']}><Routes><Route path="/matches/:matchId/record" element={<RecordPage repository={repository} createRecorder={() => recorder} createService={() => service} scheduler={scheduler} />} /><Route path="/voice/:draftId" element={<p>Draft review</p>} /></Routes></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name:'Start recording' })); await screen.findByRole('button', { name:'Stop recording' });
  expect(scheduler.schedule).toHaveBeenCalledWith(expect.any(Function), 120000); await act(async () => deadline());
  await screen.findByText('Draft review'); expect(recorder.stop).toHaveBeenCalledTimes(1); expect(clear).toHaveBeenCalled();
});
it('holds the update work guard while recording and while audio is unsaved, releasing once persisted', async () => {
  const { service } = setup(); service.persistDraftFromAudio.mockRejectedValueOnce({ code:'storage' });
  await screen.findByRole('button', { name:'Start recording' }); expect(workRegistry.isBusy()).toBe(false);
  fireEvent.click(screen.getByRole('button', { name:'Start recording' }));
  await screen.findByRole('button', { name:'Stop recording' }); expect(workRegistry.isBusy()).toBe(true);
  fireEvent.click(screen.getByRole('button', { name:'Stop recording' }));
  await screen.findByRole('button', { name:'Retry saving recording' }); expect(workRegistry.isBusy()).toBe(true);
  fireEvent.click(screen.getByRole('button', { name:'Retry saving recording' }));
  expect(await screen.findByText('Draft review')).toBeInTheDocument(); expect(workRegistry.isBusy()).toBe(false);
});
it('releases the update work guard when a recording is cancelled or the page unmounts', async () => {
  const { view } = setup();
  fireEvent.click(await screen.findByRole('button', { name:'Start recording' }));
  fireEvent.click(await screen.findByRole('button', { name:'Cancel recording' }));
  await screen.findByRole('button', { name:'Start recording' }); expect(workRegistry.isBusy()).toBe(false);
  fireEvent.click(screen.getByRole('button', { name:'Start recording' }));
  await screen.findByRole('button', { name:'Stop recording' }); expect(workRegistry.isBusy()).toBe(true);
  view.unmount(); expect(workRegistry.isBusy()).toBe(false);
});
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
type Persist = (input: { matchId: string; setId: string; audio: Blob; mimeType: string }) => Promise<Pick<VoiceDraft, 'id' | 'state'>>;
function renderWithSaveTimer(persist: ReturnType<typeof vi.fn<Persist>>) {
  const timers: Array<{ action: () => void; delay: number; cleared: boolean }> = [];
  const scheduler = { schedule:vi.fn((action: () => void, delay: number) => { const timer = { action, delay, cleared:false }; timers.push(timer); return () => { timer.cleared = true; }; }) };
  const repository = { getMatchBundle:vi.fn().mockResolvedValue(bundle), listDrafts:vi.fn().mockResolvedValue([]), close:vi.fn(), getRecoveryStatus:() => ({ mode:'normal' }) } as unknown as TennisRepository;
  const recorder = { start:vi.fn().mockResolvedValue(undefined), stop:vi.fn().mockResolvedValue({ blob:new Blob(['x']), mimeType:'audio/mp4' }), cancel:vi.fn().mockResolvedValue(undefined) };
  render(<MemoryRouter initialEntries={['/matches/m/record']}><Routes><Route path="/matches/:matchId/record" element={<RecordPage repository={repository} createRecorder={() => recorder} createService={() => ({ persistDraftFromAudio:persist })} scheduler={scheduler} />} /><Route path="/voice/:draftId" element={<p>Draft review</p>} /></Routes></MemoryRouter>);
  const saveTimeout = async () => { const timer = timers.filter(t => t.delay === SAVE_TIMEOUT_MS && !t.cleared).at(-1); expect(timer).toBeDefined(); await act(async () => timer!.action()); };
  return { saveTimeout, timers };
}
async function recordAndStop() {
  fireEvent.click(await screen.findByRole('button', { name:'Start recording' }));
  fireEvent.click(await screen.findByRole('button', { name:'Stop recording' }));
  await screen.findByText('Saving recording…');
}
const slowSave = 'Saving the recording is taking too long. It is kept on this page; retry saving, or use manual entry.';
it('stops claiming "Saving…" when a save never settles, keeping the audio, retry and manual entry', async () => {
  const pending = deferred<{ id: string; state: 'recorded' }>(); const persist = vi.fn<Persist>().mockReturnValue(pending.promise);
  const { saveTimeout } = renderWithSaveTimer(persist);
  await recordAndStop(); await saveTimeout();
  expect(screen.getByRole('alert')).toHaveTextContent(slowSave); expect(workRegistry.isBusy()).toBe(true);
  expect(screen.getByRole('button', { name:'Retry saving recording' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name:/manual entry/i })).toHaveAttribute('href', '/matches/m/live');
  // Retrying re-awaits the same pending write instead of saving the recording twice.
  fireEvent.click(screen.getByRole('button', { name:'Retry saving recording' })); await screen.findByText('Saving recording…');
  expect(persist).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve({ id:'d', state:'recorded' }));
  expect(await screen.findByText('Draft review')).toBeInTheDocument(); expect(persist).toHaveBeenCalledTimes(1);
});
it('opens the draft when a timed-out save completes later', async () => {
  const pending = deferred<{ id: string; state: 'recorded' }>(); const persist = vi.fn<Persist>().mockReturnValue(pending.promise);
  const { saveTimeout } = renderWithSaveTimer(persist);
  await recordAndStop(); await saveTimeout(); await screen.findByRole('button', { name:'Retry saving recording' });
  await act(async () => pending.resolve({ id:'d', state:'recorded' }));
  expect(await screen.findByText('Draft review')).toBeInTheDocument(); expect(persist).toHaveBeenCalledTimes(1);
});
it('writes again on retry only once a timed-out save has actually failed', async () => {
  const pending = deferred<{ id: string; state: 'recorded' }>(); const persist = vi.fn<Persist>().mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ id:'d2', state:'recorded' });
  const { saveTimeout } = renderWithSaveTimer(persist);
  await recordAndStop(); await saveTimeout();
  await act(async () => pending.reject(new Error('secret-sentinel')));
  expect(screen.getByRole('alert')).toHaveTextContent(slowSave); expect(document.body).not.toHaveTextContent('secret-sentinel');
  fireEvent.click(screen.getByRole('button', { name:'Retry saving recording' }));
  expect(await screen.findByText('Draft review')).toBeInTheDocument(); expect(persist).toHaveBeenCalledTimes(2);
  expect(persist.mock.calls[1][0].audio).toBe(persist.mock.calls[0][0].audio);
});
it('does not navigate away from a new recording when a discarded timed-out save completes', async () => {
  const pending = deferred<{ id: string; state: 'recorded' }>(); const persist = vi.fn<Persist>().mockReturnValue(pending.promise);
  const { saveTimeout } = renderWithSaveTimer(persist);
  await recordAndStop(); await saveTimeout();
  fireEvent.click(screen.getByRole('button', { name:'Start recording' })); await screen.findByRole('button', { name:'Stop recording' });
  await act(async () => pending.resolve({ id:'d', state:'recorded' }));
  expect(screen.queryByText('Draft review')).not.toBeInTheDocument(); expect(screen.getByRole('button', { name:'Stop recording' })).toBeInTheDocument();
});
it('clears the save timer once the save settles in time', async () => {
  const persist = vi.fn<Persist>().mockResolvedValue({ id:'d', state:'recorded' });
  const { timers } = renderWithSaveTimer(persist);
  fireEvent.click(await screen.findByRole('button', { name:'Start recording' }));
  fireEvent.click(await screen.findByRole('button', { name:'Stop recording' }));
  expect(await screen.findByText('Draft review')).toBeInTheDocument();
  expect(timers.filter(t => t.delay === SAVE_TIMEOUT_MS)).toHaveLength(1); expect(timers.find(t => t.delay === SAVE_TIMEOUT_MS)?.cleared).toBe(true);
});
it('explains how to enable a denied microphone', async () => {
  const { recorder } = setup(); recorder.start.mockRejectedValue({ code:'permission' });
  fireEvent.click(await screen.findByRole('button', { name:'Start recording' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/allow microphone access for this site in your browser or device settings/i);
});
it('in read-only recovery mode explains that recording is off and never starts the recorder', async () => {
  const repository = { getMatchBundle:vi.fn().mockResolvedValue(bundle), listDrafts:vi.fn().mockResolvedValue([]), close:vi.fn(), getRecoveryStatus:() => ({ mode:'readOnly', diagnostics:{ code:'newer-data-version', message:'m', failedStep:null, storedDataVersion:3, appDataVersion:2, appVersion:null, errorName:'Error' } }) } as unknown as TennisRepository;
  const recorder = { start:vi.fn().mockResolvedValue(undefined), stop:vi.fn(), cancel:vi.fn().mockResolvedValue(undefined) };
  render(<MemoryRouter initialEntries={['/matches/m/record']}><Routes><Route path="/matches/:matchId/record" element={<RecordPage repository={repository} createRecorder={() => recorder} createService={() => ({ persistDraftFromAudio:vi.fn() })} />} /></Routes></MemoryRouter>);
  const start = await screen.findByRole('button', { name:'Start recording' });
  expect(start).toBeDisabled();
  expect(screen.getByText(/read-only recovery mode/i)).toHaveTextContent(/recording is turned off/i);
  fireEvent.click(start);
  expect(recorder.start).not.toHaveBeenCalled();
});
