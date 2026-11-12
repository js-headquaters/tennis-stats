import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import type { TennisRepository } from '../../application/ports';
import type { MatchBundle } from '../../domain/model';
import RecordPage from './RecordPage';
import { dependencies } from '../../app/dependencies';

const now = '2026-01-01T00:00:00Z';
const bundle: MatchBundle = { opponent:{ id:'o', name:'Alex', normalizedName:'alex', createdAt:now, updatedAt:now }, match:{ id:'m', opponentId:'o', playedAt:now, format:'oneSet', firstServer:'player', status:'active', comments:null, createdAt:now, updatedAt:now }, sets:[{ id:'s', matchId:'m', ordinal:1, kind:'standard', status:'active', tieBreakId:null, createdAt:now, updatedAt:now }], games:[], tieBreaks:[] };
function setup() {
  const repository = { getMatchBundle:vi.fn().mockResolvedValue(bundle), close:vi.fn() } as unknown as TennisRepository;
  const recorder = { start:vi.fn().mockResolvedValue(undefined), stop:vi.fn().mockResolvedValue({ blob:new Blob(['audio'], { type:'audio/webm' }), mimeType:'audio/webm' }), cancel:vi.fn().mockResolvedValue(undefined) };
  const service = { createDraftFromAudio:vi.fn().mockResolvedValue({ id:'d', state:'ready' }) };
  const view = render(<MemoryRouter initialEntries={['/matches/m/record']}><Routes><Route path="/matches/:matchId/record" element={<RecordPage repository={repository} createRecorder={() => recorder} createService={() => service} />} /><Route path="/voice/:draftId" element={<p>Draft review</p>} /></Routes></MemoryRouter>);
  return { repository, recorder, service, view };
}
it('does nothing until start and navigates after stopping a recording', async () => {
  const { recorder, service } = setup();
  await screen.findByRole('button', { name:'Start recording' });
  expect(recorder.start).not.toHaveBeenCalled(); expect(service.createDraftFromAudio).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name:'Start recording' }));
  fireEvent.click(await screen.findByRole('button', { name:'Stop recording' }));
  expect(await screen.findByText('Draft review')).toBeInTheDocument();
  expect(service.createDraftFromAudio).toHaveBeenCalledTimes(1);
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
  expect(service.createDraftFromAudio).not.toHaveBeenCalled(); view.unmount(); expect(repository.close).not.toHaveBeenCalled();
});
it.each(['waiting-retry', 'error'])('opens a retained %s draft', async state => {
  const { service } = setup(); service.createDraftFromAudio.mockResolvedValue({ id:'d', state });
  fireEvent.click(await screen.findByRole('button', { name:'Start recording' }));
  fireEvent.click(await screen.findByRole('button', { name:'Stop recording' }));
  expect(await screen.findByText('Draft review')).toBeInTheDocument();
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
  await screen.findByText('Draft review'); expect(service.createDraftFromAudio).toHaveBeenCalledTimes(1);
});
it('closes owned repositories on failure and retry, and sanitizes load errors', async () => {
  const failed = { getMatchBundle:vi.fn().mockRejectedValue(new Error('secret-sentinel')), close:vi.fn() };
  const success = { getMatchBundle:vi.fn().mockResolvedValue(bundle), close:vi.fn() };
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
  const repository = { getMatchBundle:vi.fn().mockResolvedValue(bundle), close:vi.fn() } as unknown as TennisRepository;
  const recorder = { start:vi.fn().mockResolvedValue(undefined), stop:vi.fn().mockResolvedValue({ blob:new Blob(['x']), mimeType:'audio/webm' }), cancel:vi.fn().mockResolvedValue(undefined) };
  const service = { createDraftFromAudio:vi.fn().mockResolvedValue({ id:'d', state:'ready' }) };
  render(<MemoryRouter initialEntries={['/matches/m/record']}><Routes><Route path="/matches/:matchId/record" element={<RecordPage repository={repository} createRecorder={() => recorder} createService={() => service} scheduler={scheduler} />} /><Route path="/voice/:draftId" element={<p>Draft review</p>} /></Routes></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name:'Start recording' })); await screen.findByRole('button', { name:'Stop recording' });
  expect(scheduler.schedule).toHaveBeenCalledWith(expect.any(Function), 120000); await act(async () => deadline());
  await screen.findByText('Draft review'); expect(recorder.stop).toHaveBeenCalledTimes(1); expect(clear).toHaveBeenCalled();
});
