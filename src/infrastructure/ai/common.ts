import type { AttemptTrace } from '../../application/ports';
export type SafeProviderErrorCode = 'auth' | 'rate' | 'network' | 'config' | 'invalid-response' | 'cancelled';
const messages: Record<SafeProviderErrorCode, string> = { auth: 'Provider authentication failed.', rate: 'Provider rate limit reached.', network: 'Provider network request failed.', config: 'Provider configuration is invalid.', 'invalid-response': 'Provider returned an invalid response.', cancelled: 'Provider request was cancelled.' };
export class SafeProviderError extends Error {
  readonly code: SafeProviderErrorCode;
  constructor(code: SafeProviderErrorCode) { const safeCode = allowedCode(code); super(messages[safeCode]); this.code = safeCode; this.name = 'SafeProviderError'; }
}
function allowedCode(code: unknown): SafeProviderErrorCode { return typeof code === 'string' && Object.hasOwn(messages, code) ? code as SafeProviderErrorCode : 'network'; }
export function redactProviderError(error: unknown): SafeProviderError { try { return new SafeProviderError(error instanceof SafeProviderError ? allowedCode(error.code) : 'network'); } catch { return new SafeProviderError('network'); } }
export function validateConfig(config: { apiKey: string; model: string; endpoint: string }) {
  if (!config.apiKey.trim() || !config.model.trim()) throw new SafeProviderError('config');
  if (config.endpoint) { try { const url = new URL(config.endpoint); if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || config.endpoint.includes('?') || config.endpoint.includes('#')) throw new Error(); } catch { throw new SafeProviderError('config'); } }
}
/** Wraps a trace so a throwing method cannot change adapter behaviour, and exact/JSON-escaped/URL-escaped occurrences of `secret` are replaced by `[redacted]` in all text. Adapters wrap once and pass the result on. */
export function safeTrace(trace?: AttemptTrace, secret?: string): AttemptTrace | undefined {
  if (!trace) return undefined;
  const forms = secret && secret.length >= 4 ? [...new Set([secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)])].sort((a, b) => b.length - a.length) : [];
  const redact = (text: string) => forms.reduce((out, form) => out.split(form).join('[redacted]'), text);
  const guard = <A extends unknown[]>(call: (...args: A) => void) => (...args: A) => { try { call(...args); } catch { /* diagnostics must never affect the provider call */ } };
  return { target: guard((p: string, m: string) => trace.target(p, m)), request: guard((t: string) => trace.request(redact(t))), response: guard((t: string) => trace.response(redact(t))), httpError: guard((s: number, b: string) => trace.httpError(s, redact(b))) };
}
export async function requestJson(fetcher: typeof fetch, url: string, init: RequestInit, signal: AbortSignal, t?: AttemptTrace): Promise<unknown> {
  try {
    const response = await fetcher(url, { ...init, signal, redirect: 'error' });
    if (!response.ok) {
      let body = ''; try { body = await response.text(); } catch { body = ''; }
      t?.httpError(response.status, body);
      throw new SafeProviderError(response.status === 401 || response.status === 403 ? 'auth' : response.status === 429 ? 'rate' : 'network');
    }
    let text: string;
    try { text = await response.text(); } catch { throw new SafeProviderError('invalid-response'); }
    t?.response(text);
    try { return JSON.parse(text); } catch { throw new SafeProviderError('invalid-response'); }
  } catch (error) { if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw new SafeProviderError('cancelled'); throw redactProviderError(error); }
}
