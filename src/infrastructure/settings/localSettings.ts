import type { AiSettingsStore, ParserSettings, TranscriptionSettings } from '../../application/ports';

const transcriptionDefault: TranscriptionSettings = { provider: 'openai', model: 'gpt-transcribe', endpoint: '', apiKey: '' };
const parserDefault: ParserSettings = { provider: 'openai', model: 'gpt-4o-mini', endpoint: '', apiKey: '' };
const keys = { transcription: 'tennis.ai.transcription', parser: 'tennis.ai.parser' };
export function createLocalSettings(storage: Storage): AiSettingsStore {
  function read<T>(key: string, defaults: T): T { try { const value = storage.getItem(key); return value ? { ...defaults, ...JSON.parse(value) } : { ...defaults }; } catch { return { ...defaults }; } }
  return {
    getTranscription: () => read(keys.transcription, transcriptionDefault),
    saveTranscription: value => storage.setItem(keys.transcription, JSON.stringify(value)),
    getParser: () => read(keys.parser, parserDefault),
    saveParser: value => storage.setItem(keys.parser, JSON.stringify(value)),
    clear: kind => { const value = kind === 'transcription' ? read(keys.transcription, transcriptionDefault) : read(keys.parser, parserDefault); storage.setItem(keys[kind], JSON.stringify({ ...value, apiKey: '' })); },
  };
}
export function publicSettings(store: AiSettingsStore) {
  const { provider: transcriptionProvider, model: transcriptionModel, endpoint: transcriptionEndpoint } = store.getTranscription();
  const { provider: parserProvider, model: parserModel, endpoint: parserEndpoint } = store.getParser();
  // Endpoints may contain credentials; do not expose them in export helpers.
  void transcriptionEndpoint; void parserEndpoint;
  return { transcription: { provider: transcriptionProvider, model: transcriptionModel }, parser: { provider: parserProvider, model: parserModel } };
}
