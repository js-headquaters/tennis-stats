// @vitest-environment node
import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../infrastructure/db/database';
import { addGames, startMatch, updateComments } from './matchService';
import { createDraftService, parserContext } from './draftService';
import type { StatisticsParser, TranscriptionProvider } from './ports';
import { ReadOnlyRecoveryError } from './recovery';

type Timer = { fire: () => void; delay: number; cleared: boolean };
function manualScheduler() {
  const timers: Timer[] = [];
  return { timers, schedule(action: () => void, delay: number) { const timer: Timer = { fire: () => { if (!timer.cleared) action(); }, delay, cleared: false }; timers.push(timer); return () => { timer.cleared = true; }; } };
}
const clock = { now: () => '2026-01-01T00:00:00.000Z' };
let n = 0;
async function setup() {
  const name = `draft-service-${++n}`;
  const repository = await openDatabase(name);
  const ids = { next: () => `id-${++n}` };
  const match = await startMatch({ opponentName: 'Alex', playedAt: clock.now(), firstServer: 'player' }, { repository, ids, clock });
  const transcriber = { transcribe: vi.fn<TranscriptionProvider['transcribe']>(async () => ({ text: 'won', provider: 'test', model: 'model' })) };
  const parsed = { version: 2 as const, games: [{ server: 'player' as const, result: 'won' as const, netErrors: 0, wideErrors: null, longErrors: null, doubleFaults: null, failedReturns: null, unforcedErrors: null, comments: null }], warnings: ['check'] };
  const parser = { parse: vi.fn<StatisticsParser['parse']>(async () => parsed) };
  const isOnline = vi.fn(() => true);
  const scheduler = manualScheduler();
  const service = createDraftService({ repository, ids, clock, transcriber, parser, isOnline, scheduler });
  return { scheduler, repository, match, transcriber, parser, service, parsed, isOnline, name };
}
describe('draft processing', () => {
  async function recorded(ctx: Awaited<ReturnType<typeof setup>>) {
    return ctx.service.persistDraftFromAudio({ matchId:ctx.match.match.id, setId:ctx.match.sets[0].id, audio:new Blob(['audio']), mimeType:'audio/mp4' });
  }
  it('times out a hung transcription with a safe retryable state, then retries without duplicate calls', async () => {
    const ctx = await setup(); const { service, transcriber, parser, scheduler, repository } = ctx; const draft = await recorded(ctx);
    let seen!: AbortSignal; transcriber.transcribe.mockImplementationOnce(() => new Promise(() => {}) as never).mockImplementationOnce(async (_input, signal) => { seen = signal; return { text:'won', provider:'test', model:'model' }; });
    const first = service.retryDraft(draft.id, new AbortController().signal);
    await vi.waitFor(() => expect(scheduler.timers).toHaveLength(1));
    expect(scheduler.timers[0].delay).toBe(60000); scheduler.timers[0].fire();
    const saved = await first;
    expect(saved.state).toBe('waiting-retry'); expect(saved.error).toEqual({ code:'timeout', message:'Provider request timed out.', phase:'transcription' });
    expect((await repository.getDraft(draft.id))?.recording).toBeInstanceOf(Blob); expect(transcriber.transcribe).toHaveBeenCalledTimes(1); expect(parser.parse).not.toHaveBeenCalled();
    expect((await service.retryDraft(draft.id, new AbortController().signal)).state).toBe('ready');
    expect(transcriber.transcribe).toHaveBeenCalledTimes(2); expect(parser.parse).toHaveBeenCalledTimes(1); expect(seen.aborted).toBe(false);
  });
  it('aborts the provider signal on timeout and ignores provider error text', async () => {
    const ctx = await setup(); const { service, transcriber, scheduler } = ctx; const draft = await recorded(ctx);
    let seen!: AbortSignal; transcriber.transcribe.mockImplementationOnce((_input, signal) => { seen = signal; return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('sk-secret leaked')))); });
    const promise = service.retryDraft(draft.id, new AbortController().signal);
    await vi.waitFor(() => expect(scheduler.timers).toHaveLength(1)); scheduler.timers[0].fire();
    const saved = await promise; expect(seen.aborted).toBe(true); expect(saved.error?.code).toBe('timeout'); expect(JSON.stringify(saved.error)).not.toContain('secret');
  });
  it('times out a hung parser after keeping the transcript, and retries only the parser', async () => {
    const ctx = await setup(); const { service, transcriber, parser, scheduler, parsed } = ctx; const draft = await recorded(ctx);
    parser.parse.mockImplementationOnce(() => new Promise(() => {}) as never);
    const first = service.retryDraft(draft.id, new AbortController().signal);
    await vi.waitFor(() => expect(scheduler.timers).toHaveLength(2)); scheduler.timers[1].fire();
    const saved = await first; expect(saved.state).toBe('waiting-retry'); expect(saved.error).toEqual({ code:'timeout', message:'Provider request timed out.', phase:'parser' }); expect(saved.transcripts).toHaveLength(1);
    parser.parse.mockResolvedValueOnce(parsed);
    expect((await service.retryDraft(draft.id, new AbortController().signal)).state).toBe('ready');
    expect(transcriber.transcribe).toHaveBeenCalledTimes(1); expect(parser.parse).toHaveBeenCalledTimes(2);
  });
  it('clears every timer after completion so none can fire later', async () => {
    const ctx = await setup(); const { service, scheduler } = ctx; const draft = await recorded(ctx);
    expect((await service.retryDraft(draft.id, new AbortController().signal)).state).toBe('ready');
    expect(scheduler.timers).toHaveLength(2); expect(scheduler.timers.every(timer => timer.cleared)).toBe(true);
  });
  it('turns a caller abort into a neutral cancelled waiting-retry draft, even if the provider ignores the signal', async () => {
    const ctx = await setup(); const { service, transcriber, parser, scheduler, repository } = ctx; const draft = await recorded(ctx);
    transcriber.transcribe.mockImplementationOnce(() => new Promise(() => {}) as never);
    const controller = new AbortController(); const promise = service.retryDraft(draft.id, controller.signal);
    await vi.waitFor(() => expect(scheduler.timers).toHaveLength(1)); controller.abort();
    const saved = await promise;
    expect(saved.state).toBe('waiting-retry'); expect(saved.error).toEqual({ code:'cancelled', message:'Processing cancelled.', phase:'transcription' });
    expect(scheduler.timers[0].cleared).toBe(true); expect((await repository.getDraft(draft.id))?.state).toBe('waiting-retry'); expect((await repository.getDraft(draft.id))?.recording).toBeInstanceOf(Blob); expect(parser.parse).not.toHaveBeenCalled();
  });
  it('does not call a provider when already cancelled', async () => {
    const ctx = await setup(); const { service, transcriber } = ctx; const draft = await recorded(ctx);
    const controller = new AbortController(); controller.abort();
    expect((await service.retryDraft(draft.id, controller.signal)).error?.code).toBe('cancelled'); expect(transcriber.transcribe).not.toHaveBeenCalled();
  });
  it('persists an audio draft without starting either provider', async () => {
    const { service, repository, match, transcriber, parser } = await setup();
    const draft = await service.persistDraftFromAudio({ matchId:match.match.id, setId:match.sets[0].id, audio:new Blob(['audio']), mimeType:'audio/mp4' });
    expect(draft.state).toBe('recorded'); expect(await (await repository.getDraft(draft.id))?.recording?.text()).toBe('audio');
    expect(transcriber.transcribe).not.toHaveBeenCalled(); expect(parser.parse).not.toHaveBeenCalled();
  });
  it('preserves two concurrently prepared drafts, requiring the stale one to retry', async () => {
    const { service, match, repository } = await setup(); const signal = new AbortController().signal;
    const a = await service.createDraftFromAudio({ matchId:match.match.id, setId:match.sets[0].id, audio:new Blob(['a']), mimeType:'audio/mp4' }, signal);
    const b = await service.createDraftFromAudio({ matchId:match.match.id, setId:match.sets[0].id, audio:new Blob(['b']), mimeType:'audio/mp4' }, signal);
    const original = repository.confirmDraft.bind(repository); let release!: () => void; let count = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(repository, 'confirmDraft').mockImplementation(async (...args) => { if (++count === 2) release(); await gate; return original(...args); });
    const results = await Promise.allSettled([service.confirmDraft(a.id), service.confirmDraft(b.id)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const loser = results[0].status === 'rejected' ? a : b;
    expect((await repository.getDraft(loser.id))?.state).toBe('ready');
    expect((await service.confirmDraft(loser.id)).bundle.games).toHaveLength(2);
  });
  it('rejects a stale confirmation without losing a concurrent manual edit, then appends on retry', async () => {
    const { service, match, repository } = await setup();
    const draft = await service.createDraftFromAudio({ matchId:match.match.id, setId:match.sets[0].id, audio:new Blob(['a']), mimeType:'audio/mp4' }, new AbortController().signal);
    const original = repository.confirmDraft.bind(repository);
    vi.spyOn(repository, 'confirmDraft').mockImplementationOnce(async (...args) => {
      const current = (await repository.getMatchBundle(match.match.id))!;
      await repository.saveMatchBundle({ ...current, match:{ ...current.match, comments:'manual edit' } });
      return original(...args);
    });
    await expect(service.confirmDraft(draft.id)).rejects.toThrow();
    expect((await repository.getMatchBundle(match.match.id))?.match.comments).toBe('manual edit');
    expect((await repository.getDraft(draft.id))?.state).toBe('ready');
    const result = await service.confirmDraft(draft.id);
    expect(result.bundle.match.comments).toBe('manual edit'); expect(result.bundle.games).toHaveLength(1);
  });
  it('confirms once, shares the in-flight promise and reloads the persisted bundle', async () => {
    const { service, match, repository, transcriber, parser } = await setup();
    const draft = await service.createDraftFromAudio({ matchId: match.match.id, setId: match.sets[0].id, audio: new Blob(['a']), mimeType: 'audio/mp4' }, new AbortController().signal);
    expect((await repository.getMatchBundle(match.match.id))?.games).toHaveLength(0);
    const first = service.confirmDraft(draft.id); const second = service.confirmDraft(draft.id);
    expect(first).toBe(second);
    const result = await first;
    expect(result.status).toBe('confirmed');
    expect(result.bundle.games).toHaveLength(1);
    expect(result.bundle).toEqual(await repository.getMatchBundle(match.match.id));
    expect(await service.confirmDraft(draft.id)).toEqual({ status: 'alreadyConfirmed', bundle: result.bundle });
    expect(transcriber.transcribe).toHaveBeenCalledTimes(1);
    expect(parser.parse).toHaveBeenCalledTimes(1);
  });
  it('returns one persisted game batch when separate instances confirm concurrently', async () => {
    const { service, match, repository, transcriber, parser, name } = await setup();
    const draft = await service.createDraftFromAudio({ matchId: match.match.id, setId: match.sets[0].id, audio: new Blob(['a']), mimeType: 'audio/mp4' }, new AbortController().signal);
    const secondRepository = await openDatabase(name);
    const other = createDraftService({ repository: secondRepository, transcriber, parser, clock, ids: { next: () => `other-${++n}` }, isOnline: () => true });
    const results = await Promise.all([service.confirmDraft(draft.id), other.confirmDraft(draft.id)]);
    expect(results.map(r => r.status).sort()).toEqual(['alreadyConfirmed', 'confirmed']);
    expect(results[0].bundle).toEqual(results[1].bundle);
    expect(results[0].bundle.games).toHaveLength(1);
    expect(await repository.getDraft(draft.id)).toBeUndefined();
    secondRepository.close();
  });
  it('restores the complete draft after a failed confirmation transaction without leaking errors', async () => {
    const { service, match, repository } = await setup();
    const draft = await service.createDraftFromAudio({ matchId: match.match.id, setId: match.sets[0].id, audio: new Blob(['audio']), mimeType: 'audio/mp4' }, new AbortController().signal);
    vi.spyOn(repository, 'confirmDraft').mockRejectedValueOnce(new Error('SECRET'));
    await expect(service.confirmDraft(draft.id)).rejects.toMatchObject({ code: 'storage' });
    const saved = await repository.getDraft(draft.id);
    expect(saved).toEqual(draft);
    expect(await saved?.recording?.text()).toBe('audio');
    expect((await repository.getMatchBundle(match.match.id))?.games).toHaveLength(0);
  });
  it('does not call the confirmation transaction when saving confirming state fails', async () => {
    const { service, match, repository } = await setup();
    const draft = await service.createDraftFromAudio({ matchId: match.match.id, setId: match.sets[0].id, audio: new Blob(['a']), mimeType: 'audio/mp4' }, new AbortController().signal);
    vi.spyOn(repository, 'saveDraft').mockRejectedValueOnce(new Error('SECRET'));
    const transaction = vi.spyOn(repository, 'confirmDraft');
    await expect(service.confirmDraft(draft.id)).rejects.toMatchObject({ code: 'storage' });
    expect(transaction).not.toHaveBeenCalled();
  });
  it('persists multiple reviewed games with nulls, zeroes and their servers', async () => {
    const { service, match, repository, parser, parsed } = await setup();
    parser.parse.mockResolvedValueOnce({ ...parsed, games: [parsed.games[0], { ...parsed.games[0], server: 'opponent', result: 'lost', netErrors: null, failedReturns: 0, unforcedErrors: null, comments: null }] });
    const draft = await service.createDraftFromAudio({ matchId: match.match.id, setId: match.sets[0].id, audio: new Blob(['a']), mimeType: 'audio/mp4' }, new AbortController().signal);
    const result = await service.confirmDraft(draft.id);
    expect(result.bundle.games).toMatchObject([{ server: 'player', netErrors: 0, wideErrors: null }, { server: 'opponent', netErrors: null, failedReturns: 0, unforcedErrors: null, comments: null }]);
    expect(result.bundle).toEqual(await repository.getMatchBundle(match.match.id));
  });
  it('rejects a non-ready draft and preserves it', async () => {
    const { service, match, repository, isOnline } = await setup();
    isOnline.mockReturnValue(false);
    const draft = await service.createDraftFromAudio({ matchId: match.match.id, setId: match.sets[0].id, audio: new Blob(['a']), mimeType: 'audio/mp4' }, new AbortController().signal);
    await expect(service.confirmDraft(draft.id)).rejects.toThrow('not ready');
    expect(await repository.getDraft(draft.id)).toEqual(draft);
  });
  it('preserves the draft on invalid preparation', async () => {
    const { service, match, repository } = await setup();
    const draft = await service.createDraftFromAudio({ matchId: match.match.id, setId: match.sets[0].id, audio: new Blob(['a']), mimeType: 'audio/mp4' }, new AbortController().signal);
    const invalid = { ...draft, parsedDraft: { ...draft.parsedDraft!, games: [] } };
    await repository.saveDraft(invalid);
    await expect(service.confirmDraft(draft.id)).rejects.toThrow('could not be confirmed');
    expect(await repository.getDraft(draft.id)).toEqual(invalid);
    expect((await repository.getMatchBundle(match.match.id))?.games).toHaveLength(0);
  });
  it('fails closed when confirmation reports success without a durable marker', async () => {
    const { service, match, repository } = await setup();
    const draft = await service.createDraftFromAudio({ matchId: match.match.id, setId: match.sets[0].id, audio: new Blob(['a']), mimeType: 'audio/mp4' }, new AbortController().signal);
    vi.spyOn(repository, 'confirmDraft').mockResolvedValueOnce({ status: 'alreadyConfirmed' });
    await expect(service.confirmDraft(draft.id)).rejects.toMatchObject({ code: 'storage' });
    expect((await repository.getDraft(draft.id))?.state).toBe('ready');
  });
  it('rejects a marker that does not match the draft binding', async () => {
    const { service, match, repository } = await setup();
    const draft = await service.createDraftFromAudio({ matchId: match.match.id, setId: match.sets[0].id, audio: new Blob(['a']), mimeType: 'audio/mp4' }, new AbortController().signal);
    vi.spyOn(repository, 'confirmDraft').mockImplementationOnce(async () => {
      vi.spyOn(repository, 'getDraftConfirmation').mockResolvedValue({ confirmationId: 'wrong', matchId: draft.matchId, confirmedAt: 'now' });
      throw new Error('secret');
    });
    await expect(service.confirmDraft(draft.id)).rejects.toMatchObject({ code: 'storage' });
    expect((await repository.getDraft(draft.id))?.state).toBe('confirming');
  });
  it('persists audio and transcript before the respective provider calls', async () => {
    const { repository, match, transcriber, parser, service, parsed } = await setup();
    const audio = new Blob(['sound'], { type: 'audio/mp4' });
    const save = vi.spyOn(repository, 'saveDraft');
    transcriber.transcribe.mockImplementation(async () => { expect(save.mock.calls.at(-1)?.[0]).toMatchObject({ recording: audio, state: 'processing' }); return { text: 'won', provider: 'test', model: 'model' }; });
    parser.parse.mockImplementation(async request => { expect(save.mock.calls.at(-1)?.[0].transcripts).toHaveLength(1); expect(request).toMatchObject({ transcript: 'won', context: expect.objectContaining({ expectedNextServer: 'player' }) }); return parsed; });
    const controller = new AbortController(); const signal = controller.signal;
    const result = await service.createDraftFromAudio({ matchId: match.match.id, setId: match.sets[0].id, audio, mimeType: 'audio/mp4' }, signal);
    expect(result).toMatchObject({ state: 'ready', parsedDraft: parsed });
    const passed = transcriber.transcribe.mock.calls[0][1]; expect(passed.aborted).toBe(false); expect(controller.signal).toBe(signal);
  });
  it('retains transcript and prior parse across a failed refinement and retries only the parser', async () => {
    const { service, match, parser, transcriber, parsed, repository } = await setup();
    const signal = new AbortController().signal;
    const audio = new Blob(['first']);
    const initial = await service.createDraftFromAudio({ matchId: match.match.id, setId: match.sets[0].id, audio, mimeType: 'audio/mp4' }, signal);
    parser.parse.mockRejectedValueOnce(new Error('SECRET https://example.test/key'));
    const second = new Blob(['second']);
    const failed = await service.refineDraftWithAudio(initial.id, { audio: second, mimeType: 'audio/aac' }, signal);
    expect(failed).toMatchObject({ state: 'waiting-retry', recording: second, parsedDraft: parsed, error: { code: 'network', phase: 'parser' } });
    expect(JSON.stringify(failed.error)).not.toContain('SECRET');
    expect(failed.transcripts).toHaveLength(2);
    const retry = await service.retryDraft(initial.id, signal);
    expect(retry.state).toBe('ready');
    expect(transcriber.transcribe).toHaveBeenCalledTimes(2);
    expect(parser.parse.mock.calls.at(-1)?.[0].existingDraft).toEqual(parsed);
    expect((await repository.getDraft(initial.id))?.confirmationId).toBe(initial.confirmationId);
  });
  it('guards simultaneous retries before repository reads complete', async () => {
    const { service, match, transcriber } = await setup();
    const signal = new AbortController().signal;
    const initial = await service.createDraftFromAudio({ matchId: match.match.id, setId: match.sets[0].id, audio: new Blob(['a']), mimeType: 'audio/mp4' }, signal);
    let release!: () => void;
    transcriber.transcribe.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ text: 'x', provider: 'p', model: 'm' }); }));
    const running = service.refineDraftWithAudio(initial.id, { audio: new Blob(['b']), mimeType: 'audio/mp4' }, signal);
    await expect(service.retryDraft(initial.id, signal)).rejects.toThrow('already processing');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release(); await running;
    expect(transcriber.transcribe).toHaveBeenCalledTimes(2);
  });
  it('validates manual edits without saving invalid values', async () => {
    const { service, match, repository } = await setup();
    const draft = await service.createDraftFromAudio({ matchId: match.match.id, setId: match.sets[0].id, audio: new Blob(['a']), mimeType: 'audio/mp4' }, new AbortController().signal);
    const save = vi.spyOn(repository, 'saveDraft');
    await expect(service.updateDraftGame(draft.id, 0, { failedReturns: 0, unforcedErrors: null, comments: null })).rejects.toThrow();
    await expect(service.updateDraftGame(draft.id, 2, { netErrors: 0 })).rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
    const edited = await service.updateDraftGame(draft.id, 0, { netErrors: null, doubleFaults: 0 });
    expect(edited.parsedDraft?.games[0]).toMatchObject({ netErrors: null, doubleFaults: 0 });
  });
  it('does not start processing when the active standard set is awaiting its tie-break', async () => {
    const { service, match, transcriber, repository } = await setup();
    const bundle = structuredClone(match);
    bundle.games = Array.from({ length: 12 }, (_, i) => ({ id: `game-${i}`, setId: bundle.sets[0].id, ordinal: i + 1, server: i % 2 ? 'opponent' as const : 'player' as const, result: i % 2 ? 'lost' as const : 'won' as const, score: null, netErrors: null, wideErrors: null, longErrors: null, doubleFaults: null, failedReturns: null, unforcedErrors: null, comments: null, createdAt: clock.now(), updatedAt: clock.now() }));
    await repository.saveMatchBundle(bundle);
    await expect(service.createDraftFromAudio({ matchId: match.match.id, setId: match.sets[0].id, audio: new Blob(['a']), mimeType: 'audio/mp4' }, new AbortController().signal)).rejects.toThrow();
    expect(transcriber.transcribe).not.toHaveBeenCalled();
  });
  it('keeps offline refinement audio and previous parse without calling either provider', async () => {
    const { service, match, transcriber, parser, parsed, isOnline, repository } = await setup();
    const signal = new AbortController().signal;
    const initial = await service.createDraftFromAudio({ matchId: match.match.id, setId: match.sets[0].id, audio: new Blob(['a']), mimeType: 'audio/mp4' }, signal);
    isOnline.mockReturnValue(false);
    const waiting = await service.refineDraftWithAudio(initial.id, { audio: new Blob(['b']), mimeType: 'audio/aac' }, signal);
    expect(waiting).toMatchObject({ state: 'waiting-retry', parsedDraft: parsed, mimeType: 'audio/aac', error: { phase: 'transcription' } });
    expect((await repository.getDraft(initial.id))?.recording?.size).toBe(1);
    expect(transcriber.transcribe).toHaveBeenCalledTimes(1);
    expect(parser.parse).toHaveBeenCalledTimes(1);
    isOnline.mockReturnValue(true);
    await service.retryDraft(initial.id, signal);
    expect(transcriber.transcribe).toHaveBeenCalledTimes(2);
  });
  it('rejects invalid parser data without replacing the prior result', async () => {
    const { service, match, parser, parsed } = await setup();
    const signal = new AbortController().signal;
    const initial = await service.createDraftFromAudio({ matchId: match.match.id, setId: match.sets[0].id, audio: new Blob(['a']), mimeType: 'audio/mp4' }, signal);
    parser.parse.mockResolvedValueOnce({ ...parsed, games: [{ ...parsed.games[0], netErrors: -1 }] });
    const failed = await service.refineDraftWithAudio(initial.id, { audio: new Blob(['b']), mimeType: 'audio/mp4' }, signal);
    expect(failed).toMatchObject({ state: 'waiting-retry', parsedDraft: parsed, error: { code: 'invalid-response', phase: 'parser' } });
  });
  it('returns the same updated timestamp that was persisted', async () => {
    const { match, repository, transcriber, parser } = await setup();
    let tick = 0;
    const service = createDraftService({ repository, transcriber, parser, clock: { now: () => `tick-${++tick}` }, ids: { next: () => `timestamp-${++tick}` }, isOnline: () => true });
    const draft = await service.createDraftFromAudio({ matchId: match.match.id, setId: match.sets[0].id, audio: new Blob(['a']), mimeType: 'audio/mp4' }, new AbortController().signal);
    expect(draft.updatedAt).toBe((await repository.getDraft(draft.id))?.updatedAt);
  });
  it('retains audio and safely retries a failed transcription', async () => {
    const { service, match, transcriber, parser, repository } = await setup();
    transcriber.transcribe.mockRejectedValueOnce(new Error('SECRET token https://private.invalid'));
    const signal = new AbortController().signal;
    const failed = await service.createDraftFromAudio({ matchId: match.match.id, setId: match.sets[0].id, audio: new Blob(['audio']), mimeType: 'audio/mp4' }, signal);
    expect(failed.error).toEqual({ code: 'network', message: 'Provider network request failed.', phase: 'transcription' });
    expect(parser.parse).not.toHaveBeenCalled();
    expect(await (await repository.getDraft(failed.id))?.recording?.text()).toBe('audio');
    const retried = await service.retryDraft(failed.id, signal);
    expect(retried.state).toBe('ready');
    expect(transcriber.transcribe).toHaveBeenCalledTimes(2);
  });
  it('retains the prior parsed result while a refinement parser is pending', async () => {
    const { service, match, parser, repository, parsed } = await setup();
    const signal = new AbortController().signal;
    const initial = await service.createDraftFromAudio({ matchId: match.match.id, setId: match.sets[0].id, audio: new Blob(['a']), mimeType: 'audio/mp4' }, signal);
    let release!: () => void;
    parser.parse.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ ...parsed, warnings: ['new'] }); }));
    const running = service.refineDraftWithAudio(initial.id, { audio: new Blob(['b']), mimeType: 'audio/mp4' }, signal);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect((await repository.getDraft(initial.id))?.parsedDraft).toEqual(parsed);
    release();
    expect((await running).parsedDraft?.warnings).toEqual(['new']);
  });
  it.each(['processing', 'transcript', 'ready', 'failure'] as const)('surfaces a safe storage error on the %s save without claiming uncommitted data', async boundary => {
    const { service, match, repository, parser, transcriber, parsed } = await setup();
    const signal = new AbortController().signal;
    const initial = await service.createDraftFromAudio({ matchId: match.match.id, setId: match.sets[0].id, audio: new Blob(['old']), mimeType: 'audio/mp4' }, signal);
    const realSave = repository.saveDraft.bind(repository);
    let attempts = 0;
    const save = vi.spyOn(repository, 'saveDraft').mockImplementation(async draft => {
      attempts++;
      const failing = boundary === 'processing' ? draft.state === 'processing'
        : boundary === 'transcript' ? draft.state === 'processing' && draft.transcripts.length === 2
        : boundary === 'ready' ? draft.state === 'ready'
        : draft.state === 'waiting-retry';
      if (failing) throw new Error('STORAGE_SECRET https://secret.invalid');
      return realSave(draft);
    });
    if (boundary === 'failure') transcriber.transcribe.mockRejectedValueOnce({ code: 'rate', message: 'PROVIDER_SECRET' });
    else parser.parse.mockResolvedValueOnce({ ...parsed, warnings: ['new'] });
    const operation = service.refineDraftWithAudio(initial.id, { audio: new Blob(['new']), mimeType: 'audio/aac' }, signal);
    const error = await operation.catch(value => value as Error & { code?: string });
    expect(error).toMatchObject({ code: 'storage', message: 'Changes could not be saved. Previously saved recordings may still be available.' });
    expect(String(error)).not.toContain('STORAGE_SECRET');
    const persisted = await repository.getDraft(initial.id);
    expect(await persisted?.recording?.text()).toBe('new');
    expect(persisted?.parsedDraft).toEqual(parsed);
    expect(persisted?.transcripts).toHaveLength(boundary === 'ready' ? 2 : 1);
    expect(persisted?.state).toBe(boundary === 'processing' ? 'recorded' : 'processing');
    expect(attempts).toBe(boundary === 'processing' ? 2 : boundary === 'ready' ? 4 : 3);
    save.mockRestore();
  });
  it('persists a safe provider rate failure when storage succeeds', async () => {
    const { service, match, transcriber, repository } = await setup();
    transcriber.transcribe.mockRejectedValueOnce({ code: 'rate', message: 'PROVIDER_SECRET' });
    const draft = await service.createDraftFromAudio({ matchId: match.match.id, setId: match.sets[0].id, audio: new Blob(['a']), mimeType: 'audio/mp4' }, new AbortController().signal);
    expect(draft.error).toEqual({ code: 'rate', message: 'Provider rate limit reached.', phase: 'transcription' });
    expect(await repository.getDraft(draft.id)).toEqual(draft);
  });
  it('retains the previous recording and parse when the new recording cannot be saved', async () => {
    const { service, match, repository, transcriber, parsed } = await setup();
    const signal = new AbortController().signal;
    const initial = await service.createDraftFromAudio({ matchId: match.match.id, setId: match.sets[0].id, audio: new Blob(['old']), mimeType: 'audio/mp4' }, signal);
    vi.spyOn(repository, 'saveDraft').mockRejectedValueOnce(new Error('STORAGE_SECRET'));
    await expect(service.refineDraftWithAudio(initial.id, { audio: new Blob(['new']), mimeType: 'audio/aac' }, signal)).rejects.toMatchObject({ code: 'storage' });
    const persisted = await repository.getDraft(initial.id);
    expect(await persisted?.recording?.text()).toBe('old');
    expect(persisted?.parsedDraft).toEqual(parsed);
    expect(persisted?.state).toBe('ready');
    expect(transcriber.transcribe).toHaveBeenCalledTimes(1);
  });
});

describe('discarding drafts', () => {
  const input = (match: { match: { id: string }; sets: Array<{ id: string }> }) => ({ matchId: match.match.id, setId: match.sets[0].id, audio: new Blob(['audio']), mimeType: 'audio/mp4' });
  it('deletes the draft and its audio, is idempotent and leaves match data untouched', async () => {
    const { service, match, repository } = await setup();
    const draft = await service.persistDraftFromAudio(input(match));
    const before = await repository.getMatchBundle(match.match.id);
    await service.discardDraft(draft.id);
    expect(await repository.getDraft(draft.id)).toBeUndefined();
    await expect(service.discardDraft(draft.id)).resolves.toBeUndefined();
    await expect(service.discardDraft('never-existed')).resolves.toBeUndefined();
    expect(await repository.getMatchBundle(match.match.id)).toEqual(before);
  });
  it('only removes the named draft', async () => {
    const { service, match, repository } = await setup();
    const a = await service.persistDraftFromAudio(input(match)); const b = await service.persistDraftFromAudio(input(match));
    await service.discardDraft(a.id);
    expect(await repository.getDraft(b.id)).toBeDefined();
  });
  it('does not resurrect or duplicate an already confirmed draft', async () => {
    const { service, match, repository } = await setup();
    const draft = await service.createDraftFromAudio(input(match), new AbortController().signal);
    await service.confirmDraft(draft.id);
    const games = (await repository.getMatchBundle(match.match.id))?.games.length;
    await service.discardDraft(draft.id);
    expect(await repository.getDraft(draft.id)).toBeUndefined();
    expect(await repository.getDraftConfirmation(draft.id)).toBeDefined();
    expect((await repository.getMatchBundle(match.match.id))?.games).toHaveLength(games!);
    expect((await service.confirmDraft(draft.id)).status).toBe('alreadyConfirmed');
  });
  it('is refused with the read-only recovery error and keeps the draft', async () => {
    const { service, match, repository } = await setup();
    const draft = await service.persistDraftFromAudio(input(match));
    vi.spyOn(repository, 'deleteDraft').mockRejectedValueOnce(new ReadOnlyRecoveryError());
    await expect(service.discardDraft(draft.id)).rejects.toBeInstanceOf(ReadOnlyRecoveryError);
    expect(await repository.getDraft(draft.id)).toBeDefined();
  });
  it('reports other storage failures as a safe storage error', async () => {
    const { service, match, repository } = await setup();
    const draft = await service.persistDraftFromAudio(input(match));
    vi.spyOn(repository, 'deleteDraft').mockRejectedValueOnce(new Error('secret'));
    await expect(service.discardDraft(draft.id)).rejects.toMatchObject({ code: 'storage' });
  });
  it('refuses while the draft is being processed', async () => {
    const { service, match, transcriber, repository } = await setup();
    let release!: () => void;
    transcriber.transcribe.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ text: 'x', provider: 'p', model: 'm' }); }));
    const draft = await service.persistDraftFromAudio(input(match));
    const running = service.retryDraft(draft.id, new AbortController().signal);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await expect(service.discardDraft(draft.id)).rejects.toThrow('already processing');
    release(); await running;
    expect(await repository.getDraft(draft.id)).toBeDefined();
  });
  it('marks a draft whose set already completed as not applicable, and it can still be discarded', async () => {
    const { service, match, repository } = await setup();
    const draft = await service.createDraftFromAudio(input(match), new AbortController().signal);
    const bundle = structuredClone(match);
    bundle.games = Array.from({ length: 6 }, (_, i) => ({ id: `won-${i}`, setId: bundle.sets[0].id, ordinal: i + 1, server: i % 2 ? 'opponent' as const : 'player' as const, result: 'won' as const, score: null, netErrors: null, wideErrors: null, longErrors: null, doubleFaults: null, failedReturns: null, unforcedErrors: null, comments: null, createdAt: clock.now(), updatedAt: clock.now() }));
    bundle.sets[0].status = 'completed'; bundle.sets.push({ ...bundle.sets[0], id: 'set-2', ordinal: 2, status: 'active' });
    await repository.saveMatchBundle(bundle);
    await expect(service.retryDraft(draft.id, new AbortController().signal)).rejects.toMatchObject({ code: 'not-applicable' });
    await expect(service.confirmDraft(draft.id)).rejects.toMatchObject({ code: 'not-applicable' });
    await service.discardDraft(draft.id);
    expect(await repository.getDraft(draft.id)).toBeUndefined();
    expect((await repository.getMatchBundle(match.match.id))?.games).toHaveLength(6);
  });
});

describe('parser context projection', () => {
  const game = (result: 'won' | 'lost', netErrors: number) => ({ result, netErrors, wideErrors: null, longErrors: null, doubleFaults: null, failedReturns: null, unforcedErrors: null, comments: null });
  it('contains only format, set score, game count and expected server', async () => {
    const { repository, match } = await setup();
    const deps = { repository, ids: { next: () => `p-${++n}` }, clock };
    await updateComments(match.match.id, 'SENTINEL-COMMENT', deps);
    await addGames(match.match.id, [game('won', 424242), game('lost', 1), game('won', 2)], deps);
    const bundle = (await repository.getMatchBundle(match.match.id))!;
    const set = bundle.sets.at(-1)!;
    const context = parserContext(bundle, set.id);
    expect(context).toEqual({ format: 'twoSetsSuperTiebreak', setKind: 'standard', playerGames: 2, opponentGames: 1, gamesRecorded: 3, expectedNextServer: 'opponent' });
    expect(JSON.stringify(context)).not.toMatch(/Alex|SENTINEL|424242|id-/);
  });
  it('projects a deciding super tie-break set as zero games', () => {
    const bundle = { match: { id: 'm', opponentId: 'o', playedAt: 'x', format: 'twoSetsSuperTiebreak', firstServer: 'player', status: 'active', comments: 'SENTINEL-COMMENT', createdAt: 'x', updatedAt: 'x' }, opponent: { id: 'o', name: 'SENTINEL-OPPONENT-NAME', createdAt: 'x', updatedAt: 'x' }, sets: [{ id: 's3', matchId: 'm', ordinal: 3, kind: 'decidingSuperTiebreak', status: 'active', tieBreakId: null, createdAt: 'x', updatedAt: 'x' }], games: [], tieBreaks: [] };
    expect(parserContext(bundle as never, 's3')).toEqual({ format: 'twoSetsSuperTiebreak', setKind: 'decidingSuperTiebreak', playerGames: 0, opponentGames: 0, gamesRecorded: 0, expectedNextServer: 'player' });
  });
  it('sends exactly the projection to the parser', async () => {
    const { service, match, parser } = await setup();
    await service.createDraftFromAudio({ matchId: match.match.id, setId: match.sets[0].id, audio: new Blob(['a']), mimeType: 'audio/mp4' }, new AbortController().signal).catch(() => {});
    const request = parser.parse.mock.calls[0][0];
    expect(request).toEqual({ transcript: 'won', context: { format: 'twoSetsSuperTiebreak', setKind: 'standard', playerGames: 0, opponentGames: 0, gamesRecorded: 0, expectedNextServer: 'player' } });
    expect(JSON.stringify(request)).not.toContain('Alex');
  });
});

describe('draft diagnostics', () => {
  const abortable = (signal: AbortSignal) => new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
  async function recorded(ctx: Awaited<ReturnType<typeof setup>>) {
    return ctx.service.persistDraftFromAudio({ matchId: ctx.match.match.id, setId: ctx.match.sets[0].id, audio: new Blob(['audio']), mimeType: 'audio/mp4' });
  }
  const rows = (ctx: Awaited<ReturnType<typeof setup>>) => ctx.repository.listDiagnostics(ctx.match.match.id);
  const live = () => new AbortController().signal;
  function tracing(ctx: Awaited<ReturnType<typeof setup>>) {
    ctx.transcriber.transcribe.mockImplementation(async (_i, _s, trace) => { trace?.target('openai', 'whisper'); trace?.response('{"raw":1}'); return { text: 'won', provider: 'test', model: 'model' }; });
    ctx.parser.parse.mockImplementation(async (_r, _s, trace) => { trace?.target('anthropic', 'claude'); trace?.request('REQ'); trace?.response('{"raw":2}'); return ctx.parsed; });
  }
  it('writes one transcription and one parser row on success', async () => {
    const ctx = await setup(); tracing(ctx); const draft = await recorded(ctx);
    expect((await ctx.service.retryDraft(draft.id, live())).state).toBe('ready');
    const list = await rows(ctx); expect(list).toHaveLength(2);
    const [t, p] = [list.find(r => r.phase === 'transcription')!, list.find(r => r.phase === 'parser')!];
    expect(t).toMatchObject({ attempt: 1, outcome: 'success', provider: 'openai', model: 'whisper', draftId: draft.id, error: null });
    expect(t.transcript?.value).toBe('won'); expect(t.response?.value).toBe('{"raw":1}');
    expect(p).toMatchObject({ attempt: 1, outcome: 'success', provider: 'anthropic', model: 'claude' });
    expect(p.transcript?.value).toBe('won'); expect(p.request?.value).toBe('REQ'); expect(p.response?.value).toBe('{"raw":2}');
  });
  it('falls back to transcript provider/model, then unknown, for trace-less fakes', async () => {
    const ctx = await setup(); const draft = await recorded(ctx);
    await ctx.service.retryDraft(draft.id, live());
    const list = await rows(ctx);
    expect(list.find(r => r.phase === 'transcription')).toMatchObject({ provider: 'test', model: 'model' });
    expect(list.find(r => r.phase === 'parser')).toMatchObject({ provider: 'test', model: 'model' });
    const ctx2 = await setup(); ctx2.transcriber.transcribe.mockRejectedValueOnce(new Error('x')); const d2 = await recorded(ctx2);
    await ctx2.service.retryDraft(d2.id, live());
    expect(await rows(ctx2)).toMatchObject([{ provider: 'unknown', model: 'unknown', outcome: 'error', error: { code: 'network' } }]);
  });
  it('records a failed attempt with HTTP details, then a successful retry with attempt 2', async () => {
    const ctx = await setup(); const draft = await recorded(ctx);
    ctx.transcriber.transcribe.mockImplementationOnce(async (_i, _s, trace) => { trace?.target('openai', 'whisper'); trace?.httpError(500, 'boom'); throw { code: 'network' }; });
    expect((await ctx.service.retryDraft(draft.id, live())).state).toBe('waiting-retry');
    expect((await ctx.service.retryDraft(draft.id, live())).state).toBe('ready');
    const t = (await rows(ctx)).filter(r => r.phase === 'transcription');
    expect(t.map(r => [r.attempt, r.outcome])).toEqual([[1, 'error'], [2, 'success']]);
    expect(t[0].error).toMatchObject({ code: 'network', message: 'Provider network request failed.', status: 500, body: { value: 'boom' } });
  });
  it('writes exactly one timeout row and none when the hung provider settles later', async () => {
    const ctx = await setup(); const draft = await recorded(ctx);
    let release!: () => void;
    ctx.transcriber.transcribe.mockImplementationOnce((_i, _s, trace) => new Promise(resolve => { release = () => { trace?.response('late'); resolve({ text: 'won', provider: 'p', model: 'm' }); }; }));
    const promise = ctx.service.retryDraft(draft.id, live());
    await vi.waitFor(() => expect(ctx.scheduler.timers).toHaveLength(1)); ctx.scheduler.timers[0].fire();
    expect((await promise).error?.code).toBe('timeout');
    release(); await new Promise(resolve => setTimeout(resolve, 10));
    expect(await rows(ctx)).toMatchObject([{ outcome: 'timeout', error: { code: 'timeout' } }]);
  });
  it('writes a cancelled row on abort', async () => {
    const ctx = await setup(); const draft = await recorded(ctx);
    ctx.transcriber.transcribe.mockImplementationOnce((_i, signal) => abortable(signal));
    const controller = new AbortController(); const promise = ctx.service.retryDraft(draft.id, controller.signal);
    await vi.waitFor(() => expect(ctx.scheduler.timers).toHaveLength(1)); controller.abort(); await promise;
    expect(await rows(ctx)).toMatchObject([{ outcome: 'cancelled', error: { code: 'cancelled' } }]);
  });
  it('writes one offline row and calls no provider when offline', async () => {
    const ctx = await setup(); ctx.isOnline.mockReturnValue(false); const draft = await recorded(ctx);
    expect((await ctx.service.retryDraft(draft.id, live())).error?.code).toBe('offline');
    expect(await rows(ctx)).toMatchObject([{ outcome: 'offline', phase: 'transcription', error: { code: 'offline' } }]);
    expect(ctx.transcriber.transcribe).not.toHaveBeenCalled();
  });
  it('keeps rows after confirm and discard', async () => {
    const ctx = await setup(); const draft = await recorded(ctx);
    await ctx.service.retryDraft(draft.id, live()); await ctx.service.confirmDraft(draft.id);
    expect(await rows(ctx)).toHaveLength(2);
    const other = await recorded(ctx); await ctx.service.retryDraft(other.id, live()); await ctx.service.discardDraft(other.id);
    expect(await rows(ctx)).toHaveLength(4);
  });
  it('records an invalid parser shape as invalid-response with the response kept', async () => {
    const ctx = await setup(); const draft = await recorded(ctx);
    ctx.parser.parse.mockImplementationOnce(async (_r, _s, trace) => { trace?.response('{"bad":true}'); return { bad: true } as never; });
    expect((await ctx.service.retryDraft(draft.id, live())).error?.code).toBe('invalid-response');
    const p = (await rows(ctx)).find(r => r.phase === 'parser')!;
    expect(p).toMatchObject({ outcome: 'error', error: { code: 'invalid-response' } }); expect(p.response?.value).toBe('{"bad":true}');
  });
  it('never lets a failing diagnostics write change the draft result', async () => {
    const ctx = await setup(); const draft = await recorded(ctx);
    vi.spyOn(ctx.repository, 'saveDiagnostic').mockRejectedValue(new Error('SENTINEL_FAKE_KEY'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await ctx.service.retryDraft(draft.id, live())).state).toBe('ready');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('SENTINEL');
    const ctx2 = await setup(); const d2 = await recorded(ctx2);
    vi.spyOn(ctx2.repository, 'saveDiagnostic').mockRejectedValue(new Error('nope'));
    ctx2.transcriber.transcribe.mockRejectedValueOnce({ code: 'auth' });
    const saved = await ctx2.service.retryDraft(d2.id, live());
    expect(saved.state).toBe('waiting-retry'); expect(saved.error).toEqual({ code: 'auth', message: 'Provider authentication failed.', phase: 'transcription' });
    warn.mockRestore();
  });
  it('appends rows with incremented attempt on refine', async () => {
    const ctx = await setup(); const draft = await recorded(ctx);
    await ctx.service.retryDraft(draft.id, live()); await ctx.service.refineDraftWithAudio(draft.id, { audio: new Blob(['b']), mimeType: 'audio/mp4' }, live());
    const list = await rows(ctx);
    expect(list.filter(r => r.phase === 'transcription').map(r => r.attempt)).toEqual([1, 2]);
    expect(list.filter(r => r.phase === 'parser').map(r => r.attempt)).toEqual([1, 2]);
  });
  it('keeps a sentinel secret out of every row', async () => {
    const ctx = await setup(); const draft = await recorded(ctx);
    ctx.transcriber.transcribe.mockRejectedValueOnce(new Error('SENTINEL_FAKE_KEY'));
    await ctx.service.retryDraft(draft.id, live());
    expect(JSON.stringify(await rows(ctx))).not.toContain('SENTINEL_FAKE_KEY');
  });
});

describe('game totals and comments', () => {
  const audio = () => ({ audio: new Blob(['a']), mimeType: 'audio/mp4' });
  async function ready(ctx: Awaited<ReturnType<typeof setup>>) {
    return ctx.service.createDraftFromAudio({ matchId: ctx.match.match.id, setId: ctx.match.sets[0].id, ...audio() }, new AbortController().signal);
  }
  it('updates and trims comments and totals through manual draft edits', async () => {
    const ctx = await setup(); const draft = await ready(ctx);
    const edited = await ctx.service.updateDraftGame(draft.id, 0, { unforcedErrors: 3, comments: '  late on the backhand  ' });
    expect(edited.parsedDraft?.games[0]).toMatchObject({ unforcedErrors: 3, netErrors: 0, comments: 'late on the backhand' });
    expect((await ctx.repository.getDraft(draft.id))?.parsedDraft?.games[0]).toMatchObject({ unforcedErrors: 3, comments: 'late on the backhand' });
    const cleared = await ctx.service.updateDraftGame(draft.id, 0, { unforcedErrors: 0, comments: ' \n\t ' });
    expect(cleared.parsedDraft?.games[0]).toMatchObject({ unforcedErrors: 0, comments: null });
    const exact = await ctx.service.updateDraftGame(draft.id, 0, { comments: 'x'.repeat(10_000) });
    expect(exact.parsedDraft?.games[0].comments).toHaveLength(10_000);
  });
  it('rejects invalid totals and over-long comments without writing', async () => {
    const ctx = await setup(); const draft = await ready(ctx);
    const save = vi.spyOn(ctx.repository, 'saveDraft');
    for (const patch of [{ comments: 'x'.repeat(10_001) }, { unforcedErrors: -1 }, { unforcedErrors: 1.5 }, { unforcedErrors: 2 ** 53 }, { comments: 5 as never }, { unforcedErrors: undefined }, { score: null } as never])
      await expect(ctx.service.updateDraftGame(draft.id, 0, patch)).rejects.toThrow('Invalid draft game edit');
    expect(save).not.toHaveBeenCalled();
    expect((await ctx.repository.getDraft(draft.id))?.parsedDraft).toEqual(draft.parsedDraft);
  });
  it('rejects parser output missing the new fields or carrying a match comment', async () => {
    const ctx = await setup(); const { parsed, parser } = ctx;
    const { unforcedErrors: _u, ...missing } = parsed.games[0]; void _u;
    for (const response of [{ ...parsed, games: [missing] }, { ...parsed, comments: 'match' }, { ...parsed, games: [{ ...parsed.games[0], comments: 'x'.repeat(10_001) }] }]) {
      parser.parse.mockResolvedValueOnce(response as never);
      const draft = await ready(ctx);
      expect(draft).toMatchObject({ state: 'waiting-retry', parsedDraft: null, error: { code: 'invalid-response', phase: 'parser' } });
    }
  });
  it('preserves and corrects per-game comments and totals across a refinement', async () => {
    const ctx = await setup(); const { parser, parsed, service } = ctx;
    const first = { ...parsed, games: [{ ...parsed.games[0], unforcedErrors: 2, comments: 'stayed calm' }, { ...parsed.games[0], server: 'opponent' as const, result: 'lost' as const, doubleFaults: null, failedReturns: 1, unforcedErrors: 3, comments: 'late on the backhand' }] };
    parser.parse.mockResolvedValueOnce(first);
    const draft = await ready(ctx);
    const edited = await service.updateDraftGame(draft.id, 1, { comments: 'late on the backhand, rushed' });
    const refined = { ...first, games: [first.games[0], { ...edited.parsedDraft!.games[1], unforcedErrors: 4 }, { ...parsed.games[0], comments: 'third game note' }] };
    parser.parse.mockResolvedValueOnce(refined);
    const result = await service.refineDraftWithAudio(draft.id, audio(), new AbortController().signal);
    expect(parser.parse.mock.calls.at(-1)?.[0].existingDraft?.games.map(game => game.comments)).toEqual(['stayed calm', 'late on the backhand, rushed']);
    expect(result.parsedDraft?.games.map(game => [game.unforcedErrors, game.comments])).toEqual([[2, 'stayed calm'], [4, 'late on the backhand, rushed'], [null, 'third game note']]);
  });
  it('confirms each game with its own stats and comment and leaves the match comment unchanged', async () => {
    const ctx = await setup(); const { parser, parsed, service, repository, match } = ctx;
    await updateComments(match.match.id, 'General match note', { repository, clock, ids: { next: () => 'unused' } });
    const games = [
      { ...parsed.games[0], unforcedErrors: 2, netErrors: 1, comments: 'stayed calm' },
      { ...parsed.games[0], server: 'opponent' as const, result: 'lost' as const, netErrors: null, doubleFaults: null, failedReturns: 1, unforcedErrors: 3, comments: 'late on the backhand' },
      { ...parsed.games[0], netErrors: null, unforcedErrors: 0, comments: null },
    ];
    parser.parse.mockResolvedValueOnce({ ...parsed, games });
    const draft = await ready(ctx);
    const result = await service.confirmDraft(draft.id);
    expect(result.bundle.games.map(({ ordinal, server, result, unforcedErrors, netErrors, failedReturns, doubleFaults, comments }) => ({ ordinal, server, result, unforcedErrors, netErrors, failedReturns, doubleFaults, comments }))).toEqual([
      { ordinal: 1, server: 'player', result: 'won', unforcedErrors: 2, netErrors: 1, failedReturns: null, doubleFaults: null, comments: 'stayed calm' },
      { ordinal: 2, server: 'opponent', result: 'lost', unforcedErrors: 3, netErrors: null, failedReturns: 1, doubleFaults: null, comments: 'late on the backhand' },
      { ordinal: 3, server: 'player', result: 'won', unforcedErrors: 0, netErrors: null, failedReturns: null, doubleFaults: null, comments: null },
    ]);
    const stored = await repository.getMatchBundle(match.match.id);
    expect(stored?.match.comments).toBe('General match note');
    expect(stored?.games).toEqual(result.bundle.games);
  });
  it('keeps a zero-game draft unconfirmable', async () => {
    const ctx = await setup(); ctx.parser.parse.mockResolvedValueOnce({ ...ctx.parsed, games: [] });
    const draft = await ready(ctx);
    expect(draft).toMatchObject({ state: 'ready', parsedDraft: { games: [] } });
    await expect(ctx.service.confirmDraft(draft.id)).rejects.toThrow('could not be confirmed');
    expect((await ctx.repository.getMatchBundle(ctx.match.match.id))?.games).toHaveLength(0);
  });
});
