import { expect, it } from 'vitest';
import { createLocalSettings, publicSettings } from './localSettings';

it('stores independent settings and never serializes keys in public settings', () => {
  const store = createLocalSettings(localStorage); localStorage.clear();
  store.saveTranscription({ provider: 'openai', model: 'speech', endpoint: '', apiKey: 'SENTINEL_FAKE_KEY' });
  store.saveParser({ provider: 'anthropic', model: 'parser', endpoint: '', apiKey: 'OTHER_FAKE_KEY' });
  expect(JSON.stringify(publicSettings(store))).not.toContain('FAKE_KEY');
  store.clear('transcription');
  expect(store.getTranscription().apiKey).toBe('');
  expect(store.getParser().apiKey).toBe('OTHER_FAKE_KEY');
});
