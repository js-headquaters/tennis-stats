// @vitest-environment node
import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../infrastructure/db/database';
import { startMatch } from './matchService';
import { createDraftService } from './draftService';
import type { StatisticsParser, TranscriptionProvider } from './ports';

const clock = { now: () => '2026-01-01T00:00:00.000Z' };
let n = 0;
async function setup() {
  const repository = await openDatabase(`draft-service-${++n}`);
  const ids = { next: () => `id-${++n}` };
  const match = await startMatch({ opponentName: 'Alex', playedAt: clock.now(), firstServer: 'player' }, { repository, ids, clock });
  const transcriber = { transcribe: vi.fn<TranscriptionProvider['transcribe']>(async () => ({ text: 'won', provider: 'test', model: 'model' })) };
  const parsed = { version: 1 as const, games: [{ server: 'player' as const, result: 'won' as const, netErrors: 0, wideErrors: null, longErrors: null, doubleFaults: null, failedReturns: null }], warnings: ['check'] };
  const parser = { parse: vi.fn<StatisticsParser['parse']>(async () => parsed) };
  const isOnline = vi.fn(() => true);
  const service = createDraftService({ repository, ids, clock, transcriber, parser, isOnline });
  return { repository, match, transcriber, parser, service, parsed, isOnline };
}
describe('draft processing', () => {
  it('persists audio and transcript before the respective provider calls', async () => {
    const { repository, match, transcriber, parser, service, parsed } = await setup();
    const audio = new Blob(['sound'], { type: 'audio/mp4' });
    const save = vi.spyOn(repository, 'saveDraft');
    transcriber.transcribe.mockImplementation(async () => { expect(save.mock.calls.at(-1)?.[0]).toMatchObject({ recording: audio, state: 'processing' }); return { text: 'won', provider: 'test', model: 'model' }; });
    parser.parse.mockImplementation(async request => { expect(save.mock.calls.at(-1)?.[0].transcripts).toHaveLength(1); expect(request).toMatchObject({ transcript: 'won', expectedNext: 'player' }); return parsed; });
    const signal = new AbortController().signal;
    const result = await service.createDraftFromAudio({ matchId: match.match.id, setId: match.sets[0].id, audio, mimeType: 'audio/mp4' }, signal);
    expect(result).toMatchObject({ state: 'ready', parsedDraft: parsed });
    expect(transcriber.transcribe.mock.calls[0][1]).toBe(signal);
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
    await expect(service.updateDraftGame(draft.id, 0, { failedReturns: 0 })).rejects.toThrow();
    await expect(service.updateDraftGame(draft.id, 2, { netErrors: 0 })).rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
    const edited = await service.updateDraftGame(draft.id, 0, { netErrors: null, doubleFaults: 0 });
    expect(edited.parsedDraft?.games[0]).toMatchObject({ netErrors: null, doubleFaults: 0 });
  });
  it('does not start processing when the active standard set is awaiting its tie-break', async () => {
    const { service, match, transcriber, repository } = await setup();
    const bundle = structuredClone(match);
    bundle.games = Array.from({ length: 12 }, (_, i) => ({ id: `game-${i}`, setId: bundle.sets[0].id, ordinal: i + 1, server: i % 2 ? 'opponent' as const : 'player' as const, result: i % 2 ? 'lost' as const : 'won' as const, score: null, netErrors: null, wideErrors: null, longErrors: null, doubleFaults: null, failedReturns: null, createdAt: clock.now(), updatedAt: clock.now() }));
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
});
