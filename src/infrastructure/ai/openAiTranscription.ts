import type { TranscriptionProvider, TranscriptionSettings } from '../../application/ports';
import { redactProviderError, requestJson, safeTrace, SafeProviderError, validateConfig } from './common';

export function createOpenAiTranscription(config: TranscriptionSettings, fetcher: typeof fetch = fetch): TranscriptionProvider {
  return { async transcribe(request, signal, trace) {
    try {
    const t = safeTrace(trace, config.apiKey); t?.target('openai', config.model); validateConfig(config); const body = new FormData();
    body.append('file', request.audio, `recording.${request.mimeType.includes('wav') ? 'wav' : request.mimeType.includes('mp4') ? 'mp4' : 'webm'}`); body.append('model', config.model);
    if (request.language) body.append('language', request.language); if (request.context) body.append('prompt', request.context);
    const response = await requestJson(fetcher, config.endpoint || 'https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}` }, body }, signal, t);
    if (!response || typeof response !== 'object' || !('text' in response) || typeof response.text !== 'string') throw new SafeProviderError('invalid-response');
    return { text: response.text, provider: 'openai', model: config.model };
    } catch (error) { throw redactProviderError(error); }
  } };
}
