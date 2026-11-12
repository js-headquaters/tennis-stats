import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import type { TennisRepository } from '../../application/ports';
import type { MatchBundle, VoiceDraft } from '../../domain/model';
import { createDraftService } from '../../application/draftService';
import RecordPage from './RecordPage';
import { dependencies } from '../../app/dependencies';
import { workRegistry } from '../../app/workGuard';

const now = '2026-01-01T00:00:00Z';
const bundle: MatchBundle = { opponent:{ id:'o', name:'Alex', normalizedName:'alex', createdAt:now, updatedAt:now }, match:{ id:'m', opponentId:'o', playedAt:now, format:'oneSet', firstServer:'player', status:'active', comments:null, createdAt:now, updatedAt:now }, sets:[{ id:'s', matchId:'m', ordinal:1, kind:'standard', status:'active', tieBreakId:null, createdAt:now, updatedAt:now }], games:[], tieBreaks:[] };
function setup() {
  const repository = { getMatchBundle:vi.fn().mockResolvedValue(bundle), listDrafts:vi.fn().mockResolvedValue([]), close:vi.fn() } as unknown as TennisRepository;
  const recorder = { start:vi.fn().mockResolvedValue(undefined), stop:vi.fn().mockResolvedValue({ blob:new Blob(['audio'], { type:'audio/webm' }), mimeType:'audio/webm' }), cancel:vi.fn().mockResolvedValue(undefined) };
  const service = { persistDraftFromAudio:vi.fn().mockResolvedValue({ id:'d', state:'recorded' }) };
  const view = render(<MemoryRouter initialEntries={['/matches/m/record']}><Routes><Route path="/matches/:matchId/record" element={<RecordPage repository={repository} createRecorder={() => recorder} createService={() => service} />} /><Route path="/voice/:draftId" element={<p>Draft review</p>} /></Routes></MemoryRouter>);
  return { repository, recorder, service, view };
}
it('does nothing until start and navigates after stopping a recording', async () => {
  const { recorder, service } = setup();
  await screen.findByRole('button', { name:'Start recording' });
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
    getMatchBundle:vi.fn().mockResolvedValue(bundle), close:vi.fn(),
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
  fireEvent.click(await screen.findByRole('button', { name:'Retry saving recording' }));
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
  const success = { getMatchBundle:vi.fn().mockResolvedValue(bundle), listDrafts:vi.fn().mockResolvedValue([]), close:vi.fn() };
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
  const repository = { getMatchBundle:vi.fn().mockResolvedValue(bundle), listDrafts:vi.fn().mockResolvedValue([]), close:vi.fn() } as unknown as TennisRepository;
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
