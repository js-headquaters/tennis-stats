import type { Clock, IdGenerator } from '../application/ports';
import { openDatabase } from '../infrastructure/db/database';
import type { RecoveryStatus, TennisRepository } from '../application/ports';
import { createDraftService } from '../application/draftService';
import { createAudioRecorder } from '../infrastructure/audio/mediaRecorder';
import { createLocalSettings } from '../infrastructure/settings/localSettings';
import { createOpenAiTranscription } from '../infrastructure/ai/openAiTranscription';
import { createOpenAiParser } from '../infrastructure/ai/openAiParser';
import { createAnthropicParser } from '../infrastructure/ai/anthropicParser';
import { SafeProviderError, validateConfig } from '../infrastructure/ai/common';

function configured<T extends { apiKey: string; model: string; endpoint: string }>(read: () => T): T {
  try { const value = read(); validateConfig(value); return value; }
  catch { throw new SafeProviderError('config'); }
}

export const dependencies = {
  clock: { now: () => new Date().toISOString() } satisfies Clock,
  ids: { next: () => crypto.randomUUID() } satisfies IdGenerator,
  openDatabase,
  /** Opens the app database once (running the startup migration) and reports whether it is in read-only recovery. */
  async loadRecoveryStatus(): Promise<RecoveryStatus> {
    const repository = await dependencies.openDatabase();
    try { return repository.getRecoveryStatus(); } finally { repository.close(); }
  },
  createRecorder: createAudioRecorder,
  createDraftService: (repository: TennisRepository) => createDraftService({
    repository, clock: dependencies.clock, ids: dependencies.ids, isOnline: () => navigator.onLine,
    transcriber: { async transcribe(request, signal) {
      const config = configured(() => createLocalSettings(localStorage).getTranscription());
      if (config.provider !== 'openai') throw { code: 'config' };
      return createOpenAiTranscription(config).transcribe(request, signal);
    } },
    parser: { async parse(request, signal) {
      const config = configured(() => createLocalSettings(localStorage).getParser());
      if (config.provider !== 'openai' && config.provider !== 'anthropic') throw { code: 'config' };
      return (config.provider === 'anthropic' ? createAnthropicParser(config) : createOpenAiParser(config)).parse(request, signal);
    } },
  }),
};
