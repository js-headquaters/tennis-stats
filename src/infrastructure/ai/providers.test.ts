import { expect, it, vi } from 'vitest';
import { createOpenAiTranscription } from './openAiTranscription';
import { createOpenAiParser } from './openAiParser';
import { createAnthropicParser } from './anthropicParser';
import { parsedDraftSchema } from './schemas';

const key = 'SENTINEL_FAKE_KEY';
const config = { provider: 'openai' as const, model: 'test', endpoint: '', apiKey: key };
const draft = { version: 1, games: [{ server: 'player', result: 'won', netErrors: null, wideErrors: 0, longErrors: null, doubleFaults: 0, failedReturns: null }], warnings: [] };
it('validates strict drafts and cross-field rules', () => {
  expect(parsedDraftSchema.parse(draft)).toEqual(draft);
  for (const game of [{ ...draft.games[0], netErrors: -1 }, { ...draft.games[0], wideErrors: 0.5 }, { ...draft.games[0], failedReturns: 0 }, { ...draft.games[0], server: 'opponent', doubleFaults: 0 }, { ...draft.games[0], result: 'maybe' }]) expect(parsedDraftSchema.safeParse({ ...draft, games: [game] }).success).toBe(false);
});
it('sends multipart audio and cancellation signal', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: 'hello' })));
  const signal = new AbortController().signal;
  expect(await createOpenAiTranscription(config, fetcher).transcribe({ audio: new Blob(['audio']), mimeType: 'audio/webm' }, signal)).toMatchObject({ text: 'hello' });
  expect(fetcher.mock.calls[0][1].body).toBeInstanceOf(FormData);
  expect(fetcher.mock.calls[0][1].body.get('model')).toBe('test');
  expect(fetcher.mock.calls[0][1].body.get('file')).toBeInstanceOf(Blob);
  expect(fetcher.mock.calls[0][1].signal).toBe(signal);
});
it('parses OpenAI and Anthropic structured output', async () => {
  const a = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(draft) } }] })));
  const b = vi.fn().mockResolvedValue(new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(draft) }] })));
  const signal = new AbortController().signal;
  expect(await createOpenAiParser(config, a).parse({ transcript: 'test' }, signal)).toEqual(draft);
  expect(await createAnthropicParser({ ...config, provider: 'anthropic' }, b).parse({ transcript: 'test' }, signal)).toEqual(draft);
  expect(a.mock.calls[0][1].signal).toBe(signal); expect(b.mock.calls[0][1].signal).toBe(signal);
  expect(JSON.parse(a.mock.calls[0][1].body).response_format).toEqual({ type: 'json_object' });
  expect(JSON.parse(b.mock.calls[0][1].body).system).toMatch(/untrusted/);
});
it('classifies errors and cancellation without exposing details', async () => {
  for (const [status, code] of [[401, 'auth'], [429, 'rate'], [500, 'network']] as const) {
    const fetcher = vi.fn().mockResolvedValue(new Response(key, { status }));
    await expect(createOpenAiTranscription(config, fetcher).transcribe({ audio: new Blob(), mimeType: 'audio/webm' }, new AbortController().signal)).rejects.toMatchObject({ code });
  }
  const controller = new AbortController(); controller.abort();
  await expect(createOpenAiTranscription(config, vi.fn().mockRejectedValue(new Error(key))).transcribe({ audio: new Blob(), mimeType: 'audio/webm' }, controller.signal)).rejects.toMatchObject({ code: 'cancelled' });
  await expect(createOpenAiParser(config, vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: key } }] })))).parse({ transcript: 'test' }, new AbortController().signal)).rejects.toMatchObject({ code: 'invalid-response' });
});
it('redacts provider errors, response bodies and console diagnostics', async () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  for (const fetcher of [vi.fn().mockRejectedValue(new Error(key)), vi.fn().mockResolvedValue(new Response(key, { status: 401 }))]) {
    try { await createOpenAiTranscription(config, fetcher).transcribe({ audio: new Blob(), mimeType: 'audio/webm' }, new AbortController().signal); throw new Error('expected rejection'); }
    catch (error) { expect(String(error)).not.toContain(key); expect(JSON.stringify(error)).not.toContain(key); }
  }
  expect(JSON.stringify(spy.mock.calls)).not.toContain(key); spy.mockRestore();
});
