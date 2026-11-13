import { expect, it, vi } from 'vitest';
import { createOpenAiTranscription } from './openAiTranscription';
import { createOpenAiParser } from './openAiParser';
import { createAnthropicParser } from './anthropicParser';
import { parsedDraftSchema } from './schemas';
import { redactProviderError, SafeProviderError } from './common';

const key = 'SENTINEL_FAKE_KEY';
const config = { provider: 'openai' as const, model: 'test', endpoint: '', apiKey: key };
const draft = { version: 1, games: [{ server: 'player', result: 'won', netErrors: null, wideErrors: 0, longErrors: null, doubleFaults: 0, failedReturns: null, unforcedErrors: null, comments: null }], warnings: [] };
it('rejects insecure or credential-bearing endpoints before sending keys', async () => {
  for (const endpoint of ['http://example.com/v1', 'http://192.168.1.1/v1', 'https://user:pass@example.com/v1', `https://example.com/v1?key=${key}`, 'https://example.com/v1#secret']) {
    const fetcher = vi.fn();
    await expect(createOpenAiTranscription({ ...config, endpoint }, fetcher).transcribe({ audio: new Blob(), mimeType: 'audio/webm' }, new AbortController().signal)).rejects.toMatchObject({ code: 'config' });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(createOpenAiParser({ ...config, endpoint }, fetcher).parse({ transcript: '' }, new AbortController().signal)).rejects.toMatchObject({ code: 'config' });
    await expect(createAnthropicParser({ ...config, provider: 'anthropic', endpoint }, fetcher).parse({ transcript: '' }, new AbortController().signal)).rejects.toMatchObject({ code: 'config' });
    expect(fetcher).not.toHaveBeenCalled();
  }
});
it('sanitizes serialization errors and forged safe error diagnostics', async () => {
  const thrown = { toJSON() { throw new Error(key); } };
  for (const parser of [createOpenAiParser(config, vi.fn()), createAnthropicParser({ ...config, provider: 'anthropic' }, vi.fn())]) {
    const error = await parser.parse({ transcript: '', context: thrown as never }, new AbortController().signal).catch(reason => reason);
    expect(String(error)).not.toContain(key); expect(JSON.stringify(error)).not.toContain(key);
  }
  const forged = new SafeProviderError('auth');
  Object.assign(forged, { code: key, message: key, extra: key });
  const safe = redactProviderError(forged);
  expect(safe.code).toBe('network'); expect(String(safe)).not.toContain(key); expect(JSON.stringify(safe)).not.toContain(key);
});
it('uses a valid example and explicit enum instructions in both parser prompts', async () => {
  for (const provider of ['openai', 'anthropic'] as const) {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(provider === 'openai' ? { choices: [{ message: { content: JSON.stringify(draft) } }] } : { content: [{ type: 'text', text: JSON.stringify(draft) }] })));
    const parser = provider === 'openai' ? createOpenAiParser(config, fetcher) : createAnthropicParser({ ...config, provider }, fetcher);
    await parser.parse({ transcript: '' }, new AbortController().signal);
    const body = JSON.parse(fetcher.mock.calls[0][1].body); const prompt = provider === 'openai' ? body.messages[0].content : body.system;
    expect(prompt).not.toContain('player|opponent'); expect(prompt).not.toContain('won|lost');
    expect(prompt).toMatch(/player.*opponent/); expect(prompt).toMatch(/won.*lost/);
    expect(prompt).toContain('"server":"player"'); expect(prompt).toContain('"result":"won"');
    expect(fetcher.mock.calls[0][1].redirect).toBe('error');
  }
});
it('validates strict drafts and cross-field rules', () => {
  expect(parsedDraftSchema.parse(draft)).toEqual(draft);
  for (const game of [{ ...draft.games[0], netErrors: -1 }, { ...draft.games[0], wideErrors: 0.5 }, { ...draft.games[0], failedReturns: 0, unforcedErrors: null, comments: null }, { ...draft.games[0], server: 'opponent', doubleFaults: 0 }, { ...draft.games[0], result: 'maybe' }]) expect(parsedDraftSchema.safeParse({ ...draft, games: [game] }).success).toBe(false);
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

it('sends only the minimal parser context to both providers, never opponent, comments or game history', async () => {
  const context = { format: 'bestOfThree', setKind: 'standard', playerGames: 3, opponentGames: 2, gamesRecorded: 5, expectedNextServer: 'opponent' } as const;
  // A caller that wrongly passes the whole bundle must still not leak it.
  const leaky = { transcript: 'won', context, existingDraft: draft, matchContext: { opponent: { name: 'SENTINEL-OPPONENT-NAME' }, match: { comments: 'SENTINEL-COMMENT' }, games: [{ id: 'SENTINEL-GAME-ID', netErrors: 987654 }] }, expectedNext: 'x' };
  for (const provider of ['openai', 'anthropic'] as const) {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(provider === 'openai' ? { choices: [{ message: { content: JSON.stringify(draft) } }] } : { content: [{ type: 'text', text: JSON.stringify(draft) }] })));
    const parser = provider === 'openai' ? createOpenAiParser(config, fetcher) : createAnthropicParser({ ...config, provider }, fetcher);
    await parser.parse(leaky as never, new AbortController().signal);
    const raw: string = fetcher.mock.calls[0][1].body; const body = JSON.parse(raw);
    const user = JSON.parse(provider === 'openai' ? body.messages[1].content : body.messages[0].content);
    expect(user).toEqual({ transcript: 'won', context, existingDraft: draft });
    for (const sentinel of ['SENTINEL-OPPONENT-NAME', 'SENTINEL-COMMENT', 'SENTINEL-GAME-ID', '987654']) expect(raw).not.toContain(sentinel);
  }
});
