import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AI_ENDPOINTS, expect, test, FAKE_API_KEY, REAL_KEY_PATTERNS, aiScenarios, buildMatchBundle, buildSnapshot, fakeMicrophoneState, installFakeMicrophone, mockAi, readDatabase, seedDatabase } from './fixtures';

const here = dirname(fileURLToPath(import.meta.url));

test('@smoke fixtures and specs contain no real key-shaped strings', () => {
  for (const pattern of REAL_KEY_PATTERNS) expect(FAKE_API_KEY).not.toMatch(pattern);
  // The patterns do detect real-looking keys (built at runtime so this file stays clean).
  const samples = ['sk-' + 'A'.repeat(24), 'sk-ant-' + 'b'.repeat(30), 'Bea' + 'rer ' + 'abc123def456ghi', 'x-api-key: "' + 'z'.repeat(20) + '"'];
  samples.forEach((sample, index) => expect(sample).toMatch(REAL_KEY_PATTERNS[index]));
  const files = readdirSync(here).filter(name => /\.(ts|js|json)$/.test(name));
  expect(files).toContain('fixtures.ts');
  for (const name of files) {
    const text = readFileSync(join(here, name), 'utf8');
    for (const pattern of REAL_KEY_PATTERNS) expect(text, `${name} contains a key-shaped string (${pattern})`).not.toMatch(pattern);
  }
});

const draftFor = (matchId: string, setId: string) => ({ id: 'd1', matchId, setId, confirmationId: 'c1', dataVersion: 2 as const, recording: { type: 'audio/mp4', text: 'abc' }, mimeType: 'audio/mp4', transcripts: [], parsedDraft: null, state: 'recorded' as const, error: null, createdAt: '2026-03-14T10:00:00.000Z', updatedAt: '2026-03-14T10:00:00.000Z' });

test('seedDatabase round-trips through the app database and readDatabase', async ({ page }) => {
  const bundle = buildMatchBundle({ id: 'm1', opponent: 'Alex Example', sets: [{ games: [{ result: 'won', netErrors: 0 }, 'L'] }] });
  await seedDatabase(page, buildSnapshot({ bundles: [bundle], metadata: [{ key: 'confirmed:x', value: { draftId: 'x', matchId: 'm1', confirmedAt: bundle.match.createdAt } }] }), { then: '#/matches' });
  await expect(page.getByRole('link', { name: 'Alex Example' })).toBeVisible();
  const stored = await readDatabase(page);
  expect(stored.dataVersion).toBe(3);
  expect(stored.matches).toEqual([bundle.match]);
  expect(stored.games).toEqual(bundle.games);
  expect(stored.games[0]).toMatchObject({ server: 'player', netErrors: 0, wideErrors: null });
  expect(stored.games[1].server).toBe('opponent');
  expect(stored.metadata).toEqual([{ key: 'confirmed:x', value: { draftId: 'x', matchId: 'm1', confirmedAt: bundle.match.createdAt } }]);
});

test.describe('with persistent storage', () => {
  test.use({ persistentStorage: true });
  test('seeds and reads Blob recordings (WebKit needs a persistent context for Blobs)', async ({ page }) => {
    const bundle = buildMatchBundle({ id: 'm1', opponent: 'Alex Example' });
    await seedDatabase(page, buildSnapshot({ bundles: [bundle], voiceDrafts: [draftFor('m1', 'm1-set-1')] }));
    expect((await readDatabase(page)).voiceDrafts[0].recording).toEqual({ size: 3, type: 'audio/mp4' });
  });
});

test('mockAi answers provider calls with adapter-shaped, CORS-readable replies', async ({ page }) => {
  await page.goto('#/settings');
  const ai = await mockAi(page, { ...aiScenarios.success(1), transcript: 'one game', parser: [{ type: 'status', status: 429 }, { type: 'ok' }] });
  const results = await page.evaluate(async ({ endpoints, key }) => {
    const auth = { Authorization: `Bearer ${key}` };
    const form = new FormData(); form.append('file', new Blob(['x'], { type: 'audio/mp4' }), 'recording.mp4');
    const transcription = await (await fetch(endpoints.transcription, { method: 'POST', headers: auth, body: form })).json();
    const limited = (await fetch(endpoints.openAiParser, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}' })).status;
    const openai = await (await fetch(endpoints.openAiParser, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}' })).json();
    const anthropic = await (await fetch(endpoints.anthropicParser, { method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }, body: '{}' })).json();
    const failed = await fetch('https://api.openai.com/v1/unknown').then(() => 'ok', () => 'blocked');
    return { transcription, limited, openai, anthropic, failed };
  }, { endpoints: AI_ENDPOINTS, key: FAKE_API_KEY });
  expect(results.transcription).toEqual({ text: 'one game' });
  expect(results.limited).toBe(429);
  expect(JSON.parse(results.openai.choices[0].message.content)).toEqual({ version: 2, games: [{ server: 'player', result: 'won', netErrors: null, wideErrors: null, longErrors: null, doubleFaults: null, failedReturns: null, unforcedErrors: null, comments: null }], warnings: [] });
  expect(JSON.parse(results.anthropic.content[0].text).games).toHaveLength(1);
  expect(results.failed).toBe('blocked');
  expect(ai.calls.map(call => call.kind)).toEqual(['transcription', 'openai-parser', 'openai-parser', 'anthropic-parser', 'unexpected']);
});

test('installFakeMicrophone provides deterministic recordings and failure variants', async ({ page }) => {
  await installFakeMicrophone(page, 'mp4');
  await page.goto('#/settings');
  const recorded = await page.evaluate(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream, { mimeType: 'audio/mp4' });
    const blob = await new Promise<Blob>(resolve => { recorder.ondataavailable = event => resolve(event.data); recorder.start(); recorder.stop(); });
    stream.getTracks().forEach(track => track.stop());
    return { supported: MediaRecorder.isTypeSupported('audio/mp4'), webm: MediaRecorder.isTypeSupported('audio/webm'), size: blob.size, type: blob.type };
  });
  expect(recorded).toEqual({ supported: true, webm: false, size: 416, type: 'audio/mp4' });
  expect(await fakeMicrophoneState(page)).toMatchObject({ getUserMediaCalls: 1, recordersCreated: 1, stoppedTracks: 1 });

  const denied = await page.context().newPage();
  await installFakeMicrophone(denied, 'denied');
  await denied.goto('#/settings');
  expect(await denied.evaluate(() => navigator.mediaDevices.getUserMedia({ audio: true }).then(() => 'granted', (error: Error) => error.name))).toBe('NotAllowedError');
  const unsupported = await page.context().newPage();
  await installFakeMicrophone(unsupported, 'unsupported');
  await unsupported.goto('#/settings');
  expect(await unsupported.evaluate(() => typeof window.MediaRecorder === 'undefined' && !navigator.mediaDevices)).toBe(true);
});
