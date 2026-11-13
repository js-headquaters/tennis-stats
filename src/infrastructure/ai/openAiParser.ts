import type { ParserSettings, StatisticsParser } from '../../application/ports';
import { redactProviderError, requestJson, safeTrace, SafeProviderError, validateConfig } from './common';
import { instruction, parseDraft, requestPayload } from './parserCommon';
export function createOpenAiParser(config: ParserSettings, fetcher: typeof fetch = fetch): StatisticsParser {
  return { async parse(request, signal, trace) {
    try {
    safeTrace(trace)?.target('openai', config.model); validateConfig(config);
    const payload = requestPayload(request); safeTrace(trace)?.request(payload);
    const response = await requestJson(fetcher, config.endpoint || 'https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: config.model, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: instruction }, { role: 'user', content: payload }] }) }, signal, trace);
    try { const content = (response as { choices: Array<{ message: { content: unknown } }> }).choices[0].message.content; return parseDraft(content); } catch { throw new SafeProviderError('invalid-response'); }
    } catch (error) { throw redactProviderError(error); }
  } };
}
