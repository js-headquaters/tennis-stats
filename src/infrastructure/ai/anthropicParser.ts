import type { ParserSettings, StatisticsParser } from '../../application/ports';
import { redactProviderError, requestJson, safeTrace, SafeProviderError, validateConfig } from './common';
import { instruction, parseDraft, requestPayload } from './parserCommon';
export function createAnthropicParser(config: ParserSettings, fetcher: typeof fetch = fetch): StatisticsParser {
  return { async parse(request, signal, trace) {
    try {
    safeTrace(trace)?.target('anthropic', config.model); validateConfig(config);
    const payload = requestPayload(request); safeTrace(trace)?.request(payload);
    const response = await requestJson(fetcher, config.endpoint || 'https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true', 'Content-Type': 'application/json' }, body: JSON.stringify({ model: config.model, max_tokens: 4096, system: instruction, messages: [{ role: 'user', content: payload }] }) }, signal, trace);
    try { const blocks = (response as { content: Array<{ type: string; text?: string }> }).content; return parseDraft(blocks.find(block => block.type === 'text')?.text); } catch { throw new SafeProviderError('invalid-response'); }
    } catch (error) { throw redactProviderError(error); }
  } };
}
