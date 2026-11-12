import { useState } from 'react';
import type { AiKind, ParserSettings, TranscriptionSettings } from '../../application/ports';
import { redactProviderError } from '../../infrastructure/ai/common';

type Settings = ParserSettings | TranscriptionSettings;
export function AiSettingsSection({ title, kind, initial, save, clear, testConnection }: { title: string; kind: AiKind; initial: Settings; save: (value: Settings) => void; clear: () => void; testConnection: (kind: AiKind, settings: Settings) => Promise<void> }) {
  const [settings, setSettings] = useState(initial); const [key, setKey] = useState(''); const [message, setMessage] = useState(''); const [error, setError] = useState(false);
  const current = () => ({ ...settings, apiKey: key || settings.apiKey });
  return <fieldset><legend>{title}</legend>
    <label>Provider <select value={settings.provider} onChange={event => setSettings({ ...settings, provider: event.target.value as Settings['provider'] })}><option value="openai">OpenAI</option>{kind === 'parser' && <option value="anthropic">Anthropic</option>}</select></label>
    <label>Model <input value={settings.model} onChange={event => setSettings({ ...settings, model: event.target.value })} /></label>
    <label>Endpoint (optional) <input value={settings.endpoint} onChange={event => setSettings({ ...settings, endpoint: event.target.value })} /></label>
    <label>API key <input type="password" autoComplete="off" value={key} placeholder={settings.apiKey ? 'Key saved' : ''} onChange={event => setKey(event.target.value)} /></label>
    <button type="button" onClick={() => { const value = current(); save(value); setSettings(value); setKey(''); setError(false); setMessage('Saved.'); }}>Save</button>
    <button type="button" onClick={() => { clear(); setSettings({ ...settings, apiKey: '' }); setKey(''); setError(false); setMessage('Key cleared.'); }}>Clear key</button>
    <button type="button" onClick={async () => { setMessage(''); try { await testConnection(kind, current()); setError(false); setMessage('Connection successful.'); } catch (reason) { setError(true); setMessage(redactProviderError(reason).message); } }}>Test connection</button>
    {message && <p role={error ? 'alert' : 'status'}>{message}</p>}
  </fieldset>;
}
