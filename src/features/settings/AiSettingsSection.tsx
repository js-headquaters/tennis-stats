import { useRef, useState } from 'react';
import type { AiKind, ParserSettings, TranscriptionSettings } from '../../application/ports';
import { redactProviderError } from '../../infrastructure/ai/common';

type Settings = ParserSettings | TranscriptionSettings;
export function AiSettingsSection({ title, kind, initial, save, clear, testConnection }: { title: string; kind: AiKind; initial: Settings; save: (value: Settings) => void; clear: () => void; testConnection: (kind: AiKind, settings: Settings) => Promise<void> }) {
  const [settings, setSettings] = useState(initial); const [key, setKey] = useState(''); const [message, setMessage] = useState(''); const [error, setError] = useState(false);
  const [switched, setSwitched] = useState(false); const [pending, setPending] = useState(false); const inFlight = useRef(false);
  const current = () => ({ ...settings, apiKey: key || settings.apiKey });
  const changed = () => setMessage('');
  return <fieldset disabled={pending}><legend>{title}</legend>
    <label>Provider <select value={settings.provider} onChange={event => { const provider = event.target.value as Settings['provider']; setSettings({ provider, model: provider === 'anthropic' ? 'claude-sonnet-4-5' : 'gpt-4o-mini', endpoint: '', apiKey: '' }); setKey(''); setSwitched(true); changed(); }}><option value="openai">OpenAI</option>{kind === 'parser' && <option value="anthropic">Anthropic</option>}</select></label>
    <label>Model <input value={settings.model} onChange={event => { setSettings({ ...settings, model: event.target.value }); changed(); }} /></label>
    <label>Endpoint (optional) <input value={settings.endpoint} onChange={event => { setSettings({ ...settings, endpoint: event.target.value }); changed(); }} /></label>
    <p>Test destination: {settings.endpoint ? 'custom endpoint above' : settings.provider === 'anthropic' ? 'https://api.anthropic.com/v1/messages' : kind === 'transcription' ? 'https://api.openai.com/v1/audio/transcriptions' : 'https://api.openai.com/v1/chat/completions'} ({settings.provider}).</p>
    <label>API key <input type="password" autoComplete="off" value={key} placeholder={settings.apiKey ? 'Key saved' : ''} onChange={event => { setKey(event.target.value); changed(); }} /></label>
    <button type="button" onClick={() => { if (switched && !key.trim()) { setError(true); setMessage('Enter a key for the selected provider before saving.'); return; } try { const value = current(); save(value); setSettings(value); setKey(''); setSwitched(false); setError(false); setMessage('Saved.'); } catch { setError(true); setMessage('Unable to save settings.'); } }}>Save</button>
    <button type="button" onClick={() => { try { clear(); setSettings({ ...settings, apiKey: '' }); setKey(''); setError(false); setMessage('Key cleared.'); } catch { setError(true); setMessage('Unable to clear key.'); } }}>Clear key</button>
    <button type="button" onClick={async () => { if (inFlight.current) return; if (switched) { setError(true); setMessage('Save a key for the selected provider before testing.'); return; } inFlight.current = true; setPending(true); setMessage(''); try { await testConnection(kind, current()); setError(false); setMessage('Connection successful.'); } catch (reason) { setError(true); setMessage(redactProviderError(reason).message); } finally { inFlight.current = false; setPending(false); } }}>Test connection</button>
    {message && <p role={error ? 'alert' : 'status'}>{message}</p>}
  </fieldset>;
}
