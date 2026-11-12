import { useRef, useState } from 'react';
import type { AiKind, AiSettingsStore, ParserSettings, TranscriptionSettings } from '../../application/ports';
import { createLocalSettings } from '../../infrastructure/settings/localSettings';
import { createOpenAiTranscription } from '../../infrastructure/ai/openAiTranscription';
import { createOpenAiParser } from '../../infrastructure/ai/openAiParser';
import { createAnthropicParser } from '../../infrastructure/ai/anthropicParser';
import { AiSettingsSection } from './AiSettingsSection';
import { DataSettingsSection, type DataDeps } from './DataSettingsSection';
import { ApplicationSection, type ApplicationSources } from './ApplicationSection';

type Settings = ParserSettings | TranscriptionSettings;
function silentAudio(): Blob {
  const samples = 16000; const buffer = new ArrayBuffer(44 + samples * 2); const view = new DataView(buffer);
  const text = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  text(0, 'RIFF'); view.setUint32(4, 36 + samples * 2, true); text(8, 'WAVE'); text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, samples * 2, true);
  return new Blob([buffer], { type: 'audio/wav' });
}
async function defaultTest(kind: AiKind, settings: Settings) {
  const signal = new AbortController().signal;
  if (kind === 'transcription') await createOpenAiTranscription(settings as TranscriptionSettings).transcribe({ audio: silentAudio(), mimeType: 'audio/wav' }, signal);
  else await (settings.provider === 'anthropic' ? createAnthropicParser(settings) : createOpenAiParser(settings)).parse({ transcript: '' }, signal);
}
/** Owner of the page-wide lock: an AI connection test or a data action. While one runs, every Settings section is disabled. */
type LockOwner = AiKind | 'data';
export default function SettingsPage({ store = createLocalSettings(localStorage), testConnection = defaultTest, data, application }: { store?: AiSettingsStore; testConnection?: (kind: AiKind, settings: Settings) => Promise<void>; data?: DataDeps; application?: ApplicationSources }) {
  const owner = useRef<LockOwner | null>(null); const [pending, setPending] = useState(false);
  const acquire = (kind: LockOwner) => { if (owner.current !== null) return false; owner.current = kind; setPending(true); return true; };
  const release = (kind: LockOwner) => { if (owner.current === kind) { owner.current = null; setPending(false); } };
  return <><h1>Settings</h1><p>Client-side browser-held API keys are exposed to risk. Use restricted, expiring keys with hard spend limits.</p>
    <AiSettingsSection title="Transcription" kind="transcription" initial={store.getTranscription()} save={value => store.saveTranscription(value as TranscriptionSettings)} clear={() => store.clear('transcription')} testConnection={testConnection} pending={pending} acquire={acquire} release={release} />
    <AiSettingsSection title="Statistics parser" kind="parser" initial={store.getParser()} save={value => store.saveParser(value)} clear={() => store.clear('parser')} testConnection={testConnection} pending={pending} acquire={acquire} release={release} />
    <DataSettingsSection deps={data} pending={pending} acquire={acquire} release={release} />
    <ApplicationSection repository={data?.repository} {...application} />
  </>;
}
