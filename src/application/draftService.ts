import { z } from 'zod';
import type { Clock, IdGenerator, StatisticsParser, TennisRepository, TranscriptionProvider } from './ports';
import type { DraftGame, MatchBundle, VoiceDraft } from '../domain/model';
import { validateGame } from '../domain/validation';
import { nextGameServer, prepareGames } from './matchService';
import { evaluateSet } from '../domain/scoring';

type Phase = 'transcription' | 'parser';
type Deps = { repository: TennisRepository; transcriber: TranscriptionProvider; parser: StatisticsParser; clock: Clock; ids: IdGenerator; isOnline: () => boolean };
type AudioInput = { audio: Blob; mimeType: string };
const metric = z.number().int().nonnegative().nullable();
const gameSchema = z.object({ server: z.enum(['player', 'opponent']), result: z.enum(['won', 'lost']), netErrors: metric, wideErrors: metric, longErrors: metric, doubleFaults: metric, failedReturns: metric }).strict().refine(g => g.server === 'player' ? g.failedReturns === null : g.doubleFaults === null);
const draftSchema = z.object({ version: z.literal(1), games: z.array(gameSchema), warnings: z.array(z.string()) }).strict();
const messages = { auth: 'Provider authentication failed.', rate: 'Provider rate limit reached.', network: 'Provider network request failed.', config: 'Provider configuration is invalid.', 'invalid-response': 'Provider returned an invalid response.', cancelled: 'Provider request was cancelled.', offline: 'Waiting for an internet connection.' } as const;

export class DraftStorageError extends Error {
  readonly code = 'storage';
  constructor() { super('Changes could not be saved. Previously saved recordings may still be available.'); this.name = 'DraftStorageError'; }
}

export function createDraftService({ repository, transcriber, parser, clock, ids, isOnline }: Deps) {
  const busy = new Set<string>();
  const confirmations = new Map<string, Promise<{ status: 'confirmed' | 'alreadyConfirmed'; bundle: MatchBundle }>>();
  function guard<T>(id: string, action: () => Promise<T>): Promise<T> {
    if (busy.has(id)) return Promise.reject(new Error('Draft is already processing'));
    busy.add(id);
    return action().finally(() => busy.delete(id));
  }
  async function storage<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); } catch { throw new DraftStorageError(); }
  }
  async function save(draft: VoiceDraft) { const saved = { ...draft, updatedAt: clock.now() }; await storage(() => repository.saveDraft(saved)); return saved; }
  async function applicable(draft: Pick<VoiceDraft, 'matchId' | 'setId'>): Promise<MatchBundle> {
    const bundle = await storage(() => repository.getMatchBundle(draft.matchId));
    const set = bundle?.sets.find(item => item.id === draft.setId);
    if (!bundle || bundle.match.status !== 'active' || !set || set.matchId !== draft.matchId || set.status !== 'active' || set.kind !== 'standard') throw new Error('No active standard set for draft');
    const score = evaluateSet(bundle.games.filter(game => game.setId === set.id), bundle.tieBreaks.find(tie => tie.id === set.tieBreakId) ?? null);
    if (score.completed || (score.playerGames === 6 && score.opponentGames === 6)) throw new Error('No active standard set for draft');
    return bundle;
  }
  async function load(id: string) {
    const draft = await storage(() => repository.getDraft(id));
    if (!draft) throw new Error('Draft not found');
    if (draft.state === 'confirming') throw new Error('Draft is confirming');
    return draft;
  }
  async function process(draft: VoiceDraft, phase: Phase, signal: AbortSignal) {
    const bundle = await applicable(draft);
    if (!isOnline()) {
      const waiting: VoiceDraft = { ...draft, state: 'waiting-retry', error: { code: 'offline', message: messages.offline, phase } };
      return save(waiting);
    }
    let current = await save({ ...draft, state: 'processing', error: null });
    async function providerFailure(error: unknown, failedPhase: Phase) {
      let code: keyof typeof messages = 'network';
      try {
        const candidate = (error as { code?: unknown })?.code;
        if (typeof candidate === 'string' && Object.hasOwn(messages, candidate) && candidate !== 'offline') code = candidate as keyof typeof messages;
        else if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) code = 'cancelled';
      } catch { /* Do not expose untrusted errors. */ }
      return save({ ...current, state: 'waiting-retry', error: { code, message: messages[code], phase: failedPhase } });
    }
    if (phase === 'transcription') {
      let transcript;
      try {
        if (!current.recording || !current.mimeType) throw new Error('Missing audio');
        transcript = await transcriber.transcribe({ audio: current.recording, mimeType: current.mimeType }, signal);
        if (!transcript || typeof transcript.text !== 'string' || !transcript.text.trim() || typeof transcript.provider !== 'string' || typeof transcript.model !== 'string') throw { code: 'invalid-response' };
      } catch (error) { return providerFailure(error, 'transcription'); }
      current = await save({ ...current, transcripts: [...current.transcripts, { text: transcript.text, provider: transcript.provider, model: transcript.model, timestamp: clock.now() }] });
    }
    let parsed;
    try {
      const transcript = current.transcripts.at(-1);
      if (!transcript) throw { code: 'invalid-response' };
      const response = await parser.parse({ transcript: transcript.text, matchContext: bundle, expectedNext: nextGameServer(bundle), ...(current.parsedDraft ? { existingDraft: current.parsedDraft } : {}) }, signal);
      const validated = draftSchema.safeParse(response);
      if (!validated.success) throw { code: 'invalid-response' };
      parsed = validated.data;
    } catch (error) { return providerFailure(error, 'parser'); }
    return save({ ...current, parsedDraft: parsed, state: 'ready', error: null });
  }
  function persistDraftFromAudio(input: AudioInput & { matchId: string; setId: string }) {
    const now = clock.now();
    const draft: VoiceDraft = { id: ids.next(), confirmationId: ids.next(), matchId: input.matchId, setId: input.setId, dataVersion: 1, recording: input.audio, mimeType: input.mimeType, transcripts: [], parsedDraft: null, state: 'recorded', error: null, createdAt: now, updatedAt: now };
    return guard(draft.id, async () => { await applicable(draft); return save(draft); });
  }
  async function createDraftFromAudio(input: AudioInput & { matchId: string; setId: string }, signal: AbortSignal) {
    const draft = await persistDraftFromAudio(input);
    return retryDraft(draft.id, signal);
  }
  function retryDraft(id: string, signal: AbortSignal) {
    return guard(id, async () => { const draft = await load(id); return process(draft, draft.error?.phase === 'parser' && draft.transcripts.length ? 'parser' : 'transcription', signal); });
  }
  function refineDraftWithAudio(id: string, input: AudioInput, signal: AbortSignal) {
    return guard(id, async () => { const draft = await load(id); await applicable(draft); const next: VoiceDraft = { ...draft, recording: input.audio, mimeType: input.mimeType, state: 'recorded', error: null }; await save(next); return process(next, 'transcription', signal); });
  }
  function updateDraftGame(id: string, index: number, patch: Partial<DraftGame>) {
    return guard(id, async () => {
      const draft = await load(id);
      if (draft.state !== 'ready' || !draft.parsedDraft || !Number.isInteger(index) || index < 0 || index >= draft.parsedDraft.games.length || !patch || Object.keys(patch).some(key => !['server', 'result', 'netErrors', 'wideErrors', 'longErrors', 'doubleFaults', 'failedReturns'].includes(key))) throw new Error('Invalid draft game edit');
      const game = { ...draft.parsedDraft.games[index], ...patch };
      const valid = gameSchema.safeParse(game);
      if (!valid.success || !validateGame({ ...game, id: draft.id, setId: draft.setId, ordinal: index + 1, score: null, createdAt: draft.createdAt, updatedAt: draft.updatedAt }).ok) throw new Error('Invalid draft game edit');
      const games = [...draft.parsedDraft.games]; games[index] = game;
      const next = { ...draft, parsedDraft: { ...draft.parsedDraft, games }, updatedAt: clock.now() };
      await storage(() => repository.saveDraft(next)); return next;
    });
  }
  async function confirmed(id: string, draft?: VoiceDraft) {
    const marker = await storage(() => repository.getDraftConfirmation(id));
    if (!marker) return undefined;
    if (draft && (marker.confirmationId !== draft.confirmationId || marker.matchId !== draft.matchId)) throw new DraftStorageError();
    const bundle = await storage(() => repository.getMatchBundle(marker.matchId));
    if (!bundle || bundle.match.id !== marker.matchId) throw new DraftStorageError();
    return { status: 'alreadyConfirmed' as const, bundle };
  }
  async function performConfirmation(id: string) {
    const draft = await storage(() => repository.getDraft(id));
    if (!draft) {
      const result = await confirmed(id);
      if (result) return result;
      throw new Error('Draft not found');
    }
    if ((draft.state !== 'ready' && draft.state !== 'confirming') || !draft.parsedDraft) throw new Error('Draft is not ready');
    try {
      await save({ ...draft, state: 'confirming', error: null });
      const found = await applicable(draft);
      if (found.sets.find(s => s.status === 'active')?.id !== draft.setId) throw new Error('No active standard set for draft');
      if (!draftSchema.safeParse(draft.parsedDraft).success) throw new Error('Invalid draft games');
      const prepared = prepareGames(found, draft.parsedDraft.games, { clock, ids });
      const result = await storage(() => repository.confirmDraft(id, draft.confirmationId, prepared, clock.now(), found));
      const durable = await confirmed(id, draft);
      if (!durable) throw new DraftStorageError();
      return { ...durable, status: result.status };
    } catch (error) {
      const durable = await confirmed(id, draft);
      if (durable) return durable;
      try { await save({ ...draft, state: 'ready' }); }
      catch {
        const raced = await confirmed(id, draft);
        if (raced) return raced;
        throw new DraftStorageError();
      }
      if (error instanceof DraftStorageError) throw error;
      // Untrusted errors must not be exposed through Error.cause.
      // eslint-disable-next-line preserve-caught-error
      throw new Error('Draft could not be confirmed.');
    }
  }
  function confirmDraft(id: string) {
    const pending = confirmations.get(id);
    if (pending) return pending;
    const promise = guard(id, () => performConfirmation(id)).finally(() => confirmations.delete(id));
    confirmations.set(id, promise);
    return promise;
  }
  return { persistDraftFromAudio, createDraftFromAudio, retryDraft, refineDraftWithAudio, updateDraftGame, confirmDraft };
}
