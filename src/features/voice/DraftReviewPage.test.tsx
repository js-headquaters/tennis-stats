import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import type { RecoveryStatus, TennisRepository } from '../../application/ports';
import type { VoiceDraft } from '../../domain/model';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import DraftReviewPage from './DraftReviewPage';
import { dependencies } from '../../app/dependencies';
import { workRegistry } from '../../app/workGuard';

const draft: VoiceDraft = { id:'d', matchId:'m', setId:'s', confirmationId:'c', dataVersion:1, recording:null, mimeType:null, transcripts:[{ text:'Original transcript', provider:'provider', model:'model', timestamp:'now' }], parsedDraft:{ version:1, games:[{ server:'player', result:'won', netErrors:null, wideErrors:0, longErrors:null, doubleFaults:null, failedReturns:null }], warnings:['Check score'] }, state:'ready', error:null, createdAt:'now', updatedAt:'now' };
const style = document.createElement('style'); style.textContent = readFileSync(resolve(process.cwd(), 'src/styles/global.css'), 'utf8'); document.head.append(style);
const fittingBundle = { match:{ id:'m', status:'active' }, sets:[{ id:'s', matchId:'m', status:'active', kind:'standard', tieBreakId:null }], games:[], tieBreaks:[] };
it('shows the saved draft without invoking providers or recording and confirms only on click', async () => {
  const repository = { getDraft:vi.fn().mockResolvedValue(draft), getMatchBundle:vi.fn().mockResolvedValue(fittingBundle), close:vi.fn(), getRecoveryStatus:() => ({ mode:'normal' as const }) } as unknown as TennisRepository;
  const service = { retryDraft:vi.fn(), refineDraftWithAudio:vi.fn(), updateDraftGame:vi.fn(), confirmDraft:vi.fn().mockResolvedValue({ status:'confirmed', bundle:{ match:{ id:'m' } } }), discardDraft:vi.fn() };
  const recorder = vi.fn();
  render(<MemoryRouter initialEntries={['/voice/d']}><Routes><Route path="/voice/:draftId" element={<DraftReviewPage repository={repository} createService={() => service} createRecorder={recorder} />} /><Route path="/matches/:matchId/live" element={<p>Live match</p>} /></Routes></MemoryRouter>);
  expect(await screen.findByText('Original transcript')).toBeInTheDocument();
  expect(screen.getByText('Check score')).toBeInTheDocument();
  expect(service.retryDraft).not.toHaveBeenCalled(); expect(service.confirmDraft).not.toHaveBeenCalled(); expect(recorder).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name:'Confirm and add' }));
  expect(await screen.findByText('Live match')).toBeInTheDocument(); expect(service.confirmDraft).toHaveBeenCalledTimes(1);
});

function setup(initial: VoiceDraft = draft, getRecoveryStatus: () => RecoveryStatus = () => ({ mode:'normal' }), bundle: unknown = fittingBundle) {
  const repository = { getRecoveryStatus, getDraft:vi.fn().mockResolvedValue(initial), getDraftConfirmation:vi.fn().mockResolvedValue(undefined), getMatchBundle:vi.fn().mockResolvedValue(bundle), close:vi.fn() };
  const service = { retryDraft:vi.fn().mockResolvedValue(draft), refineDraftWithAudio:vi.fn().mockResolvedValue(draft), updateDraftGame:vi.fn().mockResolvedValue(draft), confirmDraft:vi.fn().mockResolvedValue({ status:'alreadyConfirmed' as const, bundle:{ match:{ id:'m' } } }), discardDraft:vi.fn().mockResolvedValue(undefined) };
  const recorder = { start:vi.fn().mockResolvedValue(undefined), stop:vi.fn().mockResolvedValue({ blob:new Blob(['audio']), mimeType:'audio/webm' }), cancel:vi.fn().mockResolvedValue(undefined) };
  const view = render(<MemoryRouter initialEntries={['/voice/d']}><Routes><Route path="/voice/:draftId" element={<DraftReviewPage repository={repository as unknown as TennisRepository} createService={() => service} createRecorder={() => recorder} />} /><Route path="/matches/:matchId/live" element={<p>Live match</p>} /></Routes></MemoryRouter>);
  return { repository, service, recorder, view };
}
it('shows offline state, retained cards, transcript history and configuration recovery', async () => {
  const waiting = { ...draft, state:'waiting-retry' as const, error:{ code:'config', message:'secret', phase:'parser' as const }, transcripts:[...draft.transcripts, { text:'Correction', provider:'other', model:'second', timestamp:'later' }] };
  setup(waiting);
  expect(await screen.findByText(/waiting to retry/i)).toBeInTheDocument();
  expect(screen.getByText(/configuration is invalid/i)).toBeInTheDocument(); expect(screen.getByRole('link', { name:'Settings' })).toHaveAttribute('href', '/settings');
  expect(screen.getByText('Original transcript').compareDocumentPosition(screen.getByText('Correction')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getByRole('form', { name:'Draft game 1' })).toBeInTheDocument(); expect(document.body).not.toHaveTextContent('secret');
});
it('saves zero and null through the service without writing match data', async () => {
  const { service, repository } = setup(); const card = await screen.findByRole('form', { name:'Draft game 1' });
  fireEvent.change(within(card).getByLabelText('Net errors'), { target:{ value:'0' } });
  fireEvent.click(within(card).getByRole('button', { name:'Save game 1' }));
  await waitFor(() => expect(service.updateDraftGame).toHaveBeenCalledWith('d', 0, expect.objectContaining({ netErrors:0, longErrors:null, failedReturns:null })));
  expect(service.confirmDraft).not.toHaveBeenCalled(); expect(repository.close).not.toHaveBeenCalled();
});
it('retains parsed games after retry failure and locks duplicate retry', async () => {
  const { service } = setup({ ...draft, state:'waiting-retry', error:{ code:'offline', message:'ignored' } });
  let reject!: (reason: unknown) => void; service.retryDraft.mockReturnValue(new Promise((_, r) => { reject = r; }));
  const button = await screen.findByRole('button', { name:'Retry processing' }); fireEvent.click(button); fireEvent.click(button);
  expect(service.retryDraft).toHaveBeenCalledTimes(1); expect(screen.getByRole('form', { name:'Draft game 1' })).toBeInTheDocument();
  reject(new Error('secret')); expect(await screen.findByRole('alert')).toHaveTextContent(/could not retry/i); expect(document.body).not.toHaveTextContent('secret');
});
it('records refinement only on explicit stop and supports cancellation', async () => {
  const { recorder, service } = setup(); fireEvent.click(await screen.findByRole('button', { name:'Start recording' }));
  fireEvent.click(await screen.findByRole('button', { name:'Cancel recording' })); await waitFor(() => expect(recorder.cancel).toHaveBeenCalledTimes(1)); expect(service.refineDraftWithAudio).not.toHaveBeenCalled();
  fireEvent.click(await screen.findByRole('button', { name:'Start recording' })); fireEvent.click(await screen.findByRole('button', { name:'Stop recording' }));
  await waitFor(() => expect(service.refineDraftWithAudio).toHaveBeenCalledTimes(1)); expect(screen.getByRole('form', { name:'Draft game 1' })).toBeInTheDocument();
});
it('keeps manual entry on permission denial and empty audio', async () => {
  const { recorder, service } = setup(); recorder.start.mockRejectedValueOnce({ code:'permission', message:'secret' });
  fireEvent.click(await screen.findByRole('button', { name:'Start recording' })); expect(await screen.findByRole('alert')).toHaveTextContent(/permission/i); expect(screen.getByRole('alert')).toHaveTextContent(/allow microphone access for this site in your browser or device settings/i);
  fireEvent.click(screen.getByRole('button', { name:'Start recording' })); recorder.stop.mockResolvedValueOnce({ blob:new Blob(), mimeType:'audio/webm' }); fireEvent.click(await screen.findByRole('button', { name:'Stop recording' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/empty/i); expect(service.refineDraftWithAudio).not.toHaveBeenCalled(); expect(screen.getByRole('link', { name:/manual entry/i })).toBeInTheDocument();
});
it('resolves a missing draft through durable confirmation', async () => {
  const { repository, service, view } = setup(); view.unmount();
  repository.getDraft.mockResolvedValue(undefined as never);
  render(<MemoryRouter initialEntries={['/voice/d']}><Routes><Route path="/voice/:draftId" element={<DraftReviewPage repository={repository as unknown as TennisRepository} createService={() => service} />} /><Route path="/matches/:matchId/live" element={<p>Live match</p>} /></Routes></MemoryRouter>);
  expect(await screen.findByText('Live match')).toBeInTheDocument(); expect(service.confirmDraft).toHaveBeenCalledTimes(1); expect(repository.close).not.toHaveBeenCalled();
});
it('closes owned repositories once on failure and retry', async () => {
  const failed = { getDraft:vi.fn().mockRejectedValue(new Error('secret')), close:vi.fn() };
  const success = { getDraft:vi.fn().mockResolvedValue(draft), getMatchBundle:vi.fn().mockResolvedValue(fittingBundle), close:vi.fn(), getRecoveryStatus:() => ({ mode:'normal' as const }) };
  const open = vi.spyOn(dependencies, 'openDatabase').mockResolvedValueOnce(failed as never).mockResolvedValueOnce(success as never);
  const view = render(<MemoryRouter initialEntries={['/voice/d']}><Routes><Route path="/voice/:draftId" element={<DraftReviewPage />} /></Routes></MemoryRouter>);
  expect(await screen.findByRole('alert')).toHaveTextContent(/could not load/i); expect(failed.close).toHaveBeenCalledTimes(1); fireEvent.click(screen.getByRole('button', { name:'Retry loading' }));
  await screen.findByText('Original transcript'); view.unmount(); expect(success.close).toHaveBeenCalledTimes(1); expect(failed.close).toHaveBeenCalledTimes(1); open.mockRestore();
});
it('allows confirmation retry after a safe failure and blocks duplicate clicks', async () => {
  const { service } = setup(); let reject!: (reason: unknown) => void;
  service.confirmDraft.mockReturnValueOnce(new Promise((_, r) => { reject = r; }));
  const button = await screen.findByRole('button', { name:'Confirm and add' }); fireEvent.click(button); fireEvent.click(button);
  expect(service.confirmDraft).toHaveBeenCalledTimes(1); expect(screen.getByRole('button', { name:'Start recording' })).toBeDisabled();
  reject(new Error('secret')); expect(await screen.findByRole('alert')).toHaveTextContent(/could not confirm/i); expect(document.body).not.toHaveTextContent('secret');
  fireEvent.click(screen.getByRole('button', { name:'Confirm and add' })); expect(await screen.findByText('Live match')).toBeInTheDocument(); expect(service.confirmDraft).toHaveBeenCalledTimes(2);
});
it('replaces a retry result and leaves prior cards on refinement failure', async () => {
  const waiting = { ...draft, state:'waiting-retry' as const, error:{ code:'offline', message:'ignored' } };
  const { service } = setup(waiting); fireEvent.click(await screen.findByRole('button', { name:'Retry processing' }));
  await screen.findByText('Ready for review.'); expect(service.retryDraft).toHaveBeenCalledTimes(1);
  service.refineDraftWithAudio.mockRejectedValueOnce(new Error('secret')); fireEvent.click(screen.getByRole('button', { name:'Start recording' })); fireEvent.click(await screen.findByRole('button', { name:'Stop recording' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/could not process/i); expect(screen.getByRole('form', { name:'Draft game 1' })).toBeInTheDocument(); expect(document.body).not.toHaveTextContent('secret');
});
it('releases an active recorder and does not close an injected repository on unmount', async () => {
  const { recorder, repository, view } = setup(); fireEvent.click(await screen.findByRole('button', { name:'Start recording' })); await screen.findByRole('button', { name:'Stop recording' });
  view.unmount(); expect(recorder.cancel).toHaveBeenCalledTimes(1); expect(repository.close).not.toHaveBeenCalled();
});
it('blocks confirmation while a card has unsaved edits and permits it after saving', async () => {
  const { service } = setup();
  const card = await screen.findByRole('form', { name:'Draft game 1' });
  fireEvent.change(within(card).getByLabelText('Net errors'), { target:{ value:'0' } });
  expect(screen.getByRole('button', { name:'Confirm and add' })).toBeDisabled();
  expect(screen.getByText(/save or discard/i)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name:'Confirm and add' })); expect(service.confirmDraft).not.toHaveBeenCalled();
  service.updateDraftGame.mockResolvedValueOnce({ ...draft, parsedDraft:{ ...draft.parsedDraft!, games:[{ ...draft.parsedDraft!.games[0], netErrors:0 }] } });
  fireEvent.click(within(card).getByRole('button', { name:'Save game 1' }));
  await waitFor(() => expect(screen.getByRole('button', { name:'Confirm and add' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name:'Confirm and add' })); expect(await screen.findByText('Live match')).toBeInTheDocument();
});
it.each(['processing', 'confirming'] as const)('allows recovery of a reloaded %s draft', async state => {
  const { service } = setup({ ...draft, state });
  const button = await screen.findByRole('button', { name: state === 'processing' ? 'Retry processing' : 'Resume confirmation' });
  fireEvent.click(button); fireEvent.click(button);
  if (state === 'processing') await waitFor(() => expect(service.retryDraft).toHaveBeenCalledTimes(1));
  else { expect(await screen.findByText('Live match')).toBeInTheDocument(); expect(service.confirmDraft).toHaveBeenCalledTimes(1); }
});
it('starts processing a freshly recorded draft once on arrival', async () => {
  const recorded = { ...draft, state:'recorded' as const, transcripts:[], parsedDraft:null, recording:new Blob(['audio']), mimeType:'audio/mp4' };
  const { service } = setup(recorded);
  await waitFor(() => expect(service.retryDraft).toHaveBeenCalledTimes(1));
  expect(service.retryDraft).toHaveBeenCalledWith('d', expect.any(AbortSignal));
  expect(await screen.findByText('Ready for review.')).toBeInTheDocument(); expect(service.retryDraft).toHaveBeenCalledTimes(1);
  expect(service.confirmDraft).not.toHaveBeenCalled();
});
it('discarding unsaved edits restores the saved values and re-enables confirmation', async () => {
  const { service } = setup();
  const card = await screen.findByRole('form', { name:'Draft game 1' });
  fireEvent.change(within(card).getByLabelText('Wide errors'), { target:{ value:'3' } });
  expect(screen.getByRole('button', { name:'Confirm and add' })).toBeDisabled(); expect(screen.getByRole('button', { name:'Start recording' })).toBeDisabled();
  fireEvent.click(within(card).getByRole('button', { name:'Discard edits' }));
  expect(within(card).getByLabelText('Wide errors')).toHaveValue('0');
  expect(screen.getByRole('button', { name:'Confirm and add' })).toBeEnabled(); expect(screen.queryByText(/save or discard/i)).not.toBeInTheDocument();
  expect(service.updateDraftGame).not.toHaveBeenCalled();
});
it('holds the update work guard while recording, processing, or with unsaved game edits', async () => {
  const { service } = setup(); let resolve!: (value: VoiceDraft) => void; service.refineDraftWithAudio.mockReturnValue(new Promise(r => { resolve = r; }));
  const card = await screen.findByRole('form', { name:'Draft game 1' }); expect(workRegistry.isBusy()).toBe(false);
  fireEvent.change(within(card).getByLabelText('Net errors'), { target:{ value:'2' } });
  await waitFor(() => expect(workRegistry.isBusy()).toBe(true));
  fireEvent.click(within(card).getByRole('button', { name:'Save game 1' }));
  await waitFor(() => expect(workRegistry.isBusy()).toBe(false));
  fireEvent.click(await screen.findByRole('button', { name:'Start recording' }));
  await screen.findByRole('button', { name:'Stop recording' }); expect(workRegistry.isBusy()).toBe(true);
  fireEvent.click(screen.getByRole('button', { name:'Stop recording' }));
  await waitFor(() => expect(service.refineDraftWithAudio).toHaveBeenCalledTimes(1)); expect(workRegistry.isBusy()).toBe(true);
  resolve(draft);
  await waitFor(() => expect(workRegistry.isBusy()).toBe(false));
});
const readOnly = (): RecoveryStatus => ({ mode:'readOnly', diagnostics:{ code:'newer-data-version', message:'m', failedStep:null, storedDataVersion:3, appDataVersion:2, appVersion:null, errorName:'Error' } });
it.each(['ready', 'waiting-retry', 'confirming'] as const)('in read-only recovery mode keeps a %s draft viewable but disables every write control with a notice', async state => {
  const { service, recorder } = setup({ ...draft, state }, readOnly);
  expect(await screen.findByText('Original transcript')).toBeInTheDocument();
  expect(screen.getByRole('note')).toHaveTextContent(/read-only recovery mode: recording, processing and confirming drafts are turned off/i);
  const buttons = [screen.getByRole('button', { name:'Start recording' }), screen.getByRole('button', { name:'Confirm and add' })];
  if (state === 'waiting-retry') buttons.push(screen.getByRole('button', { name:'Retry processing' }));
  if (state === 'confirming') buttons.push(screen.getByRole('button', { name:'Resume confirmation' }));
  for (const button of buttons) { expect(button).toBeDisabled(); fireEvent.click(button); }
  expect(recorder.start).not.toHaveBeenCalled(); expect(service.retryDraft).not.toHaveBeenCalled(); expect(service.confirmDraft).not.toHaveBeenCalled(); expect(service.refineDraftWithAudio).not.toHaveBeenCalled();
});
it('in read-only recovery mode does not auto-process a recorded draft or show a generic error', async () => {
  const { service } = setup({ ...draft, state:'recorded', parsedDraft:null, transcripts:[] }, readOnly);
  expect(await screen.findByRole('button', { name:'Retry processing' })).toBeDisabled();
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(service.retryDraft).not.toHaveBeenCalled();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByRole('note')).toHaveTextContent(/read-only recovery mode/i);
});

const completedBundle = { ...fittingBundle, match:{ id:'m', status:'active' }, sets:[{ id:'s', matchId:'m', status:'completed', kind:'standard', tieBreakId:null }, { id:'s2', matchId:'m', status:'active', kind:'standard', tieBreakId:null }] };
const discardButton = () => screen.getByRole('button', { name:'Discard draft' });
it('discards only after an explicit confirmation step, then opens the live match', async () => {
  const { service } = setup();
  fireEvent.click(await screen.findByRole('button', { name:'Discard draft' }));
  expect(service.discardDraft).not.toHaveBeenCalled();
  expect(screen.getByText(/delete the recording and transcripts/i)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name:'Keep draft' }));
  expect(screen.queryByRole('button', { name:'Confirm discard' })).not.toBeInTheDocument();
  fireEvent.click(discardButton()); fireEvent.click(screen.getByRole('button', { name:'Confirm discard' }));
  expect(await screen.findByText('Live match')).toBeInTheDocument();
  expect(service.discardDraft).toHaveBeenCalledTimes(1); expect(service.discardDraft).toHaveBeenCalledWith('d');
});
it('locks the page and stays on it with a safe alert when discarding fails', async () => {
  const { service } = setup(); let reject!: (reason: unknown) => void;
  service.discardDraft.mockReturnValueOnce(new Promise((_, r) => { reject = r; }));
  fireEvent.click(await screen.findByRole('button', { name:'Discard draft' }));
  const confirm = screen.getByRole('button', { name:'Confirm discard' }); fireEvent.click(confirm); fireEvent.click(confirm);
  expect(service.discardDraft).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name:'Start recording' })).toBeDisabled(); expect(screen.getByRole('button', { name:'Confirm and add' })).toBeDisabled();
  reject(new Error('secret')); expect(await screen.findByRole('alert')).toHaveTextContent(/could not discard/i); expect(document.body).not.toHaveTextContent('secret');
  expect(screen.queryByText('Live match')).not.toBeInTheDocument(); expect(discardButton()).toBeEnabled();
});
it('disables discarding in read-only recovery mode', async () => {
  const { service } = setup(draft, readOnly);
  await screen.findByText('Original transcript');
  expect(discardButton()).toBeDisabled(); fireEvent.click(discardButton());
  expect(screen.queryByRole('button', { name:'Confirm discard' })).not.toBeInTheDocument(); expect(service.discardDraft).not.toHaveBeenCalled();
});
it('keeps the discard controls at least 44px tall', async () => {
  setup(); fireEvent.click(await screen.findByRole('button', { name:'Discard draft' }));
  for (const name of ['Discard draft', 'Confirm discard', 'Keep draft']) expect(parseFloat(getComputedStyle(screen.getByRole('button', { name })).minHeight)).toBeGreaterThanOrEqual(44);
});
it('explains a draft that no longer fits the match on arrival, disables apply actions and keeps Discard available', async () => {
  const { service } = setup({ ...draft, state:'waiting-retry' }, () => ({ mode:'normal' }), completedBundle);
  expect(await screen.findByText(/this draft no longer fits the match/i)).toBeInTheDocument();
  expect(screen.getByText(/set it was recorded for has already finished/i)).toBeInTheDocument();
  for (const name of ['Retry processing', 'Confirm and add', 'Start recording']) expect(screen.getByRole('button', { name })).toBeDisabled();
  expect(discardButton()).toBeEnabled();
  fireEvent.click(discardButton()); fireEvent.click(screen.getByRole('button', { name:'Confirm discard' }));
  expect(await screen.findByText('Live match')).toBeInTheDocument(); expect(service.discardDraft).toHaveBeenCalledWith('d');
});
it('does not auto-process a freshly recorded draft that no longer fits', async () => {
  const { service } = setup({ ...draft, state:'recorded', parsedDraft:null, transcripts:[] }, () => ({ mode:'normal' }), completedBundle);
  expect(await screen.findByText(/this draft no longer fits the match/i)).toBeInTheDocument();
  await new Promise(resolve => setTimeout(resolve, 20)); expect(service.retryDraft).not.toHaveBeenCalled();
});
it.each([['retryDraft', 'waiting-retry', 'Retry processing'], ['confirmDraft', 'ready', 'Confirm and add']] as const)('shows the explanation instead of a generic error when %s reports the draft no longer fits', async (method, state, label) => {
  const { service } = setup({ ...draft, state });
  service[method].mockRejectedValueOnce({ code:'not-applicable', message:'secret' });
  fireEvent.click(await screen.findByRole('button', { name:label }));
  expect(await screen.findByText(/this draft no longer fits the match/i)).toBeInTheDocument();
  expect(screen.queryByText(/could not (retry|confirm)/i)).not.toBeInTheDocument(); expect(document.body).not.toHaveTextContent('secret');
  expect(discardButton()).toBeEnabled(); expect(screen.getByRole('button', { name:label })).toBeDisabled();
});
const cancelledDraft: VoiceDraft = { ...draft, state:'waiting-retry', error:{ code:'cancelled', message:'Processing cancelled.', phase:'parser' } };
it('offers a 44px Cancel processing button only while a provider call is in flight and ends retryable', async () => {
  const { service } = setup({ ...draft, state:'waiting-retry', error:{ code:'offline', message:'x', phase:'parser' } });
  expect(await screen.findByRole('button', { name:'Retry processing' })).toBeInTheDocument(); expect(screen.queryByRole('button', { name:'Cancel processing' })).toBeNull();
  let signal!: AbortSignal;
  service.retryDraft.mockImplementation((_id: string, s: AbortSignal) => { signal = s; return new Promise(resolve => s.addEventListener('abort', () => resolve(cancelledDraft))); });
  fireEvent.click(screen.getByRole('button', { name:'Retry processing' }));
  const cancel = await screen.findByRole('button', { name:'Cancel processing' }); expect(getComputedStyle(cancel).minHeight).toBe('44px'); expect(workRegistry.isBusy()).toBe(true);
  fireEvent.click(cancel); expect(signal.aborted).toBe(true);
  expect(await screen.findByRole('button', { name:'Retry processing' })).toBeEnabled(); expect(screen.getByText('Processing cancelled.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name:'Cancel processing' })).toBeNull(); expect(screen.queryByRole('alert')).toBeNull(); await waitFor(() => expect(workRegistry.isBusy()).toBe(false)); expect(document.body).not.toHaveTextContent(/request failed|was cancelled/i);
});
it('shows a timeout message from the persisted draft', async () => {
  setup({ ...draft, state:'waiting-retry', error:{ code:'timeout', message:'x', phase:'parser' } });
  expect(await screen.findByText('Provider request timed out.')).toBeInTheDocument(); expect(screen.getByRole('button', { name:'Retry processing' })).toBeInTheDocument();
});
it('on unmount aborts the call, keeps the registry held and closes an owned repository only after the call settles', async () => {
  const repo = { getDraft:vi.fn().mockResolvedValue({ ...draft, state:'waiting-retry', error:{ code:'offline', message:'x', phase:'parser' } }), getMatchBundle:vi.fn().mockResolvedValue(fittingBundle), close:vi.fn(), getRecoveryStatus:() => ({ mode:'normal' as const }) };
  const open = vi.spyOn(dependencies, 'openDatabase').mockResolvedValueOnce(repo as never);
  let signal!: AbortSignal; let settle!: () => void; const persisted = vi.fn();
  const service = { retryDraft:vi.fn((_id: string, s: AbortSignal) => { signal = s; return new Promise(resolve => { settle = () => { persisted(repo.close.mock.calls.length); resolve(cancelledDraft); }; }); }), refineDraftWithAudio:vi.fn(), updateDraftGame:vi.fn(), confirmDraft:vi.fn(), discardDraft:vi.fn() };
  const view = render(<MemoryRouter initialEntries={['/voice/d']}><Routes><Route path="/voice/:draftId" element={<DraftReviewPage createService={() => service as never} />} /></Routes></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name:'Retry processing' })); await screen.findByRole('button', { name:'Cancel processing' });
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {}); const unhandled = vi.fn(); process.on('unhandledRejection', unhandled);
  view.unmount();
  expect(signal.aborted).toBe(true); expect(repo.close).not.toHaveBeenCalled(); expect(workRegistry.isBusy()).toBe(true);
  settle(); await waitFor(() => expect(repo.close).toHaveBeenCalledTimes(1)); expect(persisted).toHaveBeenCalledWith(0);
  await waitFor(() => expect(workRegistry.isBusy()).toBe(false)); await new Promise(resolve => setTimeout(resolve, 0));
  expect(unhandled).not.toHaveBeenCalled(); expect(errors).not.toHaveBeenCalled(); process.off('unhandledRejection', unhandled); errors.mockRestore(); open.mockRestore();
});
it('closes an owned repository after a rejected in-flight call too, and never an injected one', async () => {
  const { service, repository, view } = setup({ ...draft, state:'waiting-retry', error:{ code:'offline', message:'x', phase:'parser' } });
  let fail!: (e: unknown) => void; service.retryDraft.mockReturnValue(new Promise((_, r) => { fail = r; }));
  fireEvent.click(await screen.findByRole('button', { name:'Retry processing' })); await screen.findByRole('button', { name:'Cancel processing' });
  view.unmount(); fail(new Error('boom')); await waitFor(() => expect(workRegistry.isBusy()).toBe(false)); expect(repository.close).not.toHaveBeenCalled();
});
