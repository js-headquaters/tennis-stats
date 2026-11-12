export type SafeProviderErrorCode = 'auth' | 'rate' | 'network' | 'config' | 'invalid-response' | 'cancelled';
const messages: Record<SafeProviderErrorCode, string> = { auth: 'Provider authentication failed.', rate: 'Provider rate limit reached.', network: 'Provider network request failed.', config: 'Provider configuration is invalid.', 'invalid-response': 'Provider returned an invalid response.', cancelled: 'Provider request was cancelled.' };
export class SafeProviderError extends Error {
  constructor(public readonly code: SafeProviderErrorCode) { super(messages[code]); this.name = 'SafeProviderError'; }
}
export function redactProviderError(error: unknown): SafeProviderError { return error instanceof SafeProviderError ? new SafeProviderError(error.code) : new SafeProviderError('network'); }
export function validateConfig(config: { apiKey: string; model: string; endpoint: string }) {
  if (!config.apiKey.trim() || !config.model.trim()) throw new SafeProviderError('config');
  if (config.endpoint) { try { const url = new URL(config.endpoint); if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(); } catch { throw new SafeProviderError('config'); } }
}
export async function requestJson(fetcher: typeof fetch, url: string, init: RequestInit, signal: AbortSignal): Promise<unknown> {
  try {
    const response = await fetcher(url, { ...init, signal });
    if (!response.ok) throw new SafeProviderError(response.status === 401 || response.status === 403 ? 'auth' : response.status === 429 ? 'rate' : 'network');
    try { return await response.json(); } catch { throw new SafeProviderError('invalid-response'); }
  } catch (error) { if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw new SafeProviderError('cancelled'); throw redactProviderError(error); }
}
