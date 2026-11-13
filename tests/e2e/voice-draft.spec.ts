import type { BrowserContext, Page } from '@playwright/test';
import {
  FAKE_API_KEY, FIXED_NOW, buildDraftGame, buildMatchBundle, buildSnapshot, configureAi, expect, fakeMicrophoneState, installFakeMicrophone,
  mockAi, readDatabase, seedDatabase, test, type AiScenario, type FakeMicrophoneVariant, type SeedDraft,
} from './fixtures';
import type { DraftGame } from '../../src/domain/model';

// Journey 2 (mocked batch transcript → review several games → voice correction → "Confirm and add"), the pending-draft
// half of journey 10 (reload / offline / failed AI keeps the draft, retry succeeds, no duplicates), duplicate confirmation
// after reload, provider secret redaction, and the iOS/WebKit microphone fallback to manual entry.
// Recordings are Blobs in IndexedDB, which Playwright's ephemeral WebKit contexts reject, so every test here runs in a
// persistent context (see fixtures.ts) except the one that deliberately exercises that storage failure.

const MATCH_ID = 'm1';
const SET_ID = `${MATCH_ID}-set-1`;
const LIVE = `#/matches/${MATCH_ID}/live`;
const RECORD = `#/matches/${MATCH_ID}/record`;
const FAKE_RECORDING = { size: 416, type: 'audio/mp4' }; // fixtures.ts: `FAKE-AUDIO-<n>-`×32 for the 'mp4' microphone

const g = (server: DraftGame['server'], result: DraftGame['result'], metrics: Partial<DraftGame> = {}) => buildDraftGame({ server, result, ...metrics });
const FIRST_TRANSCRIPT = 'Game one I held with two net errors and no wide errors. Game two I lost on return, one long error and one failed return. Game three I held but double faulted once.';
const FIRST_GAMES = [
  g('player', 'won', { netErrors: 2, wideErrors: 0, doubleFaults: 0 }),
  g('opponent', 'lost', { longErrors: 1, failedReturns: 1 }),
  g('player', 'won', { doubleFaults: 1 }),
];

async function setUp(page: Page, { scenario = { games: 2 } as AiScenario, microphone = 'mp4' as FakeMicrophoneVariant, parser = 'openai' as 'openai' | 'anthropic' } = {}) {
  await page.clock.setFixedTime(new Date(FIXED_NOW));
  await configureAi(page, { parser });
  await installFakeMicrophone(page, microphone);
  return mockAi(page, scenario);
}

async function seedMatch(page: Page, { then = LIVE, voiceDrafts = [] as SeedDraft[] } = {}) {
  const bundle = buildMatchBundle({ id: MATCH_ID, opponent: 'Alex Example', format: 'oneSet', firstServer: 'player' });
  await seedDatabase(page, buildSnapshot({ bundles: [bundle], voiceDrafts }), { then });
  return bundle;
}

/** Records one fake clip on the Record page and returns the id of the draft it was saved as. */
async function recordClip(page: Page) {
  await page.getByRole('button', { name: 'Start recording' }).click();
  await page.getByRole('button', { name: 'Stop recording' }).click();
  await expect(page).toHaveURL(/#\/voice\/[^/]+$/);
  return decodeURIComponent(page.url().split('#/voice/')[1]);
}

const status = (page: Page, text: string) => page.locator('[role="status"]', { hasText: text });
const draftCard = (page: Page, n: number) => page.getByRole('form', { name: `Draft game ${n}` });
const gameRows = (games: Array<{ ordinal: number; server: string; result: string; netErrors: number | null; wideErrors: number | null; longErrors: number | null; doubleFaults: number | null; failedReturns: number | null }>) =>
  [...games].sort((a, b) => a.ordinal - b.ordinal).map(({ server, result, netErrors, wideErrors, longErrors, doubleFaults, failedReturns }) => ({ server, result, netErrors, wideErrors, longErrors, doubleFaults, failedReturns }));

test.use({ persistentStorage: true });

test('@smoke reviews a mocked batch transcript, corrects it by voice, and commits nothing until "Confirm and add"', async ({ page }) => {
  const ai = await setUp(page, { scenario: { transcript: FIRST_TRANSCRIPT, games: FIRST_GAMES } });
  await seedMatch(page);
  await page.getByRole('link', { name: 'Record with voice' }).click();
  await expect(page).toHaveURL(new RegExp(`${RECORD}$`));
  const draftId = await recordClip(page);

  // Review: transcript plus one editable card per parsed game; explicit zero and unknown stay distinct.
  await expect(status(page, 'Ready for review.')).toBeVisible();
  await expect(page.getByText(FIRST_TRANSCRIPT)).toBeVisible();
  await expect(page.locator('form.draft-game-card')).toHaveCount(3);
  await expect(draftCard(page, 1).getByLabel('Net errors')).toHaveValue('2');
  await expect(draftCard(page, 1).getByLabel('Wide errors')).toHaveValue('0');
  await expect(draftCard(page, 1).getByTestId('draft-metric-longErrors').getByLabel('Unknown')).toBeVisible();
  await expect(draftCard(page, 2).getByLabel('Server')).toHaveValue('opponent');
  await expect(draftCard(page, 2).getByLabel('Failed returns')).toHaveValue('1');

  // The providers got the audio, then the transcript with the match context; both carried the configured (fake) key.
  expect(ai.calls.map(call => call.kind)).toEqual(['transcription', 'openai-parser']);
  expect(ai.calls.every(call => call.headers.authorization === `Bearer ${FAKE_API_KEY}`)).toBe(true);
  expect(ai.callsOf('openai-parser')[0].body).toContain('two net errors');

  let stored = await readDatabase(page);
  expect(stored.games, 'nothing is written to the match before confirmation').toEqual([]);
  expect(stored.voiceDrafts).toHaveLength(1);
  expect(stored.voiceDrafts[0]).toMatchObject({ id: draftId, matchId: MATCH_ID, setId: SET_ID, state: 'ready', recording: FAKE_RECORDING, parsedDraft: { games: FIRST_GAMES } });

  // A manual edit on a draft card updates the draft only.
  await draftCard(page, 2).getByLabel('Wide errors').fill('0');
  await draftCard(page, 2).getByRole('button', { name: 'Save game 2' }).click();
  await expect(draftCard(page, 2).getByTestId('draft-metric-wideErrors')).toContainText('0');
  await expect.poll(async () => (await readDatabase(page)).voiceDrafts[0]?.parsedDraft?.games[1].wideErrors).toBe(0);
  expect((await readDatabase(page)).games).toEqual([]);

  // Voice correction: a second recording runs the same cycle with the existing draft as context and shows the revision.
  const correction = 'Correction: game three I actually lost. Then game four, opponent served and I won with no failed returns.';
  const revised = [FIRST_GAMES[0], { ...FIRST_GAMES[1], wideErrors: 0 }, g('player', 'lost', { doubleFaults: 1 }), g('opponent', 'won', { failedReturns: 0 })];
  ai.update({ transcript: correction, games: revised });
  await page.getByRole('button', { name: 'Start recording' }).click();
  await page.getByRole('button', { name: 'Stop recording' }).click();
  await expect(page.locator('form.draft-game-card')).toHaveCount(4);
  await expect(status(page, 'Ready for review.')).toBeVisible();
  await expect(page.getByText(correction)).toBeVisible();
  await expect(page.getByText(FIRST_TRANSCRIPT), 'the original transcript stays available').toBeVisible();
  await expect(draftCard(page, 3).getByLabel('Result')).toHaveValue('lost');
  await expect(draftCard(page, 4).getByLabel('Failed returns')).toHaveValue('0');
  expect(ai.calls.map(call => call.kind)).toEqual(['transcription', 'openai-parser', 'transcription', 'openai-parser']);
  const refineBody = JSON.parse(ai.callsOf('openai-parser')[1].body ?? '{}') as unknown;
  expect(JSON.stringify(refineBody), 'the refinement sends the edited draft as context').toContain('existingDraft');

  stored = await readDatabase(page);
  expect(stored.games, 'still nothing written before confirmation').toEqual([]);
  expect(stored.voiceDrafts[0].transcripts.map(t => t.text)).toEqual([FIRST_TRANSCRIPT, correction]);
  expect(stored.voiceDrafts[0].parsedDraft?.games).toEqual(revised);

  // Confirm and add: the reviewed games become match games, in order, and the draft (with its audio) is removed.
  await page.getByRole('button', { name: 'Confirm and add' }).click();
  await expect(page).toHaveURL(new RegExp(`${LIVE}$`));
  await expect(page.getByText('Set 1: 2–2 (active)')).toBeVisible();
  stored = await readDatabase(page);
  expect(gameRows(stored.games)).toEqual(revised.map(({ server, result, netErrors, wideErrors, longErrors, doubleFaults, failedReturns }) => ({ server, result, netErrors, wideErrors, longErrors, doubleFaults, failedReturns })));
  expect(stored.games.every(game => game.setId === SET_ID)).toBe(true);
  expect(stored.voiceDrafts, 'the confirmed draft and its recording are deleted').toEqual([]);
  expect(stored.metadata).toEqual([{ key: expect.stringMatching(/^draft-confirmation:/), value: { draftId, matchId: MATCH_ID, confirmedAt: FIXED_NOW } }]);
});

test.describe('duplicate confirmation', () => {
  async function confirmedTwice(page: Page, context: BrowserContext) {
    await setUp(page, { scenario: { games: 2 } });
    await seedMatch(page, { then: RECORD });
    const draftId = await recordClip(page);
    await expect(status(page, 'Ready for review.')).toBeVisible();
    // A second tab holds the same review open (stale after the first confirmation).
    const stale = await context.newPage();
    await mockAi(stale);
    await stale.goto(`#/voice/${encodeURIComponent(draftId)}`);
    await expect(status(stale, 'Ready for review.')).toBeVisible();
    return { draftId, stale };
  }

  test('reopening the old review URL or confirming from a stale tab is idempotent', async ({ page, context }) => {
    const { draftId, stale } = await confirmedTwice(page, context);
    await page.getByRole('button', { name: 'Confirm and add' }).click();
    await expect(page).toHaveURL(new RegExp(`${LIVE}$`));
    const once = await readDatabase(page);
    expect(once.games).toHaveLength(2);
    expect(once.voiceDrafts, 'confirmed audio is deleted').toEqual([]);

    // The stale tab tries again: it lands on the match without adding anything.
    await stale.getByRole('button', { name: 'Confirm and add' }).click();
    await expect(stale).toHaveURL(new RegExp(`${LIVE}$`));
    // Reloading the old review URL resolves to the already-confirmed match instead of a second confirmation.
    await page.goto(`#/voice/${encodeURIComponent(draftId)}`);
    await expect(page).toHaveURL(new RegExp(`${LIVE}$`));
    await page.reload();
    await expect(page.getByText('Set 1: 1–1 (active)')).toBeVisible();

    const after = await readDatabase(page);
    expect(after.games, 'games exist exactly once').toEqual(once.games);
    expect(after.voiceDrafts).toEqual([]);
    expect(after.metadata.filter(row => row.key.startsWith('draft-confirmation:'))).toHaveLength(1);
    // Nothing on the Record page offers the confirmed draft again.
    await page.goto(RECORD);
    await expect(page.getByRole('button', { name: 'Start recording' })).toBeVisible();
    await expect(page.getByRole('link', { name: /Resume draft/ })).toHaveCount(0);
  });
});

test.describe('pending drafts survive reloads, offline and provider failures', () => {
  test('reloading while the providers are still working keeps the draft; retry completes it once', async ({ page }) => {
    const ai = await setUp(page, { scenario: { games: 2, delay: 'manual' } });
    await seedMatch(page, { then: RECORD });
    const draftId = await recordClip(page);
    await expect(status(page, 'Processing draft…')).toBeVisible();
    await expect.poll(async () => (await readDatabase(page)).voiceDrafts.map(d => d.state)).toEqual(['processing']);

    await page.reload();
    // Persisted as interrupted processing; WebKit fails the in-flight fetch while unloading, so the app may record that
    // as a network failure first. Both are retained, retryable states.
    await expect(page.locator('[role="status"]', { hasText: /^(Processing draft…|Waiting to retry\.)$/ })).toBeVisible();
    const retry = page.getByRole('button', { name: 'Retry processing' });
    await expect(retry).toBeEnabled();
    let stored = await readDatabase(page);
    expect(stored.voiceDrafts).toHaveLength(1);
    expect(stored.voiceDrafts[0]).toMatchObject({ id: draftId, recording: FAKE_RECORDING, state: expect.stringMatching(/^(processing|waiting-retry)$/) });

    // The Record page lists the interrupted draft for resuming.
    await page.goto(RECORD);
    await page.getByRole('link', { name: /Resume draft from .* — (processing was interrupted|waiting to retry)/ }).click();
    await expect(page).toHaveURL(new RegExp(`#/voice/${draftId}$`));

    ai.release();
    await page.getByRole('button', { name: 'Retry processing' }).click();
    await expect(status(page, 'Ready for review.')).toBeVisible();
    await page.getByRole('button', { name: 'Confirm and add' }).click();
    await expect(page).toHaveURL(new RegExp(`${LIVE}$`));
    stored = await readDatabase(page);
    expect(stored.games).toHaveLength(2);
    expect(stored.voiceDrafts).toEqual([]);
  });

  test('offline: the recording is kept "waiting to retry" without calling providers, then retried once online', async ({ page, context }) => {
    const ai = await setUp(page, { scenario: { games: 2 } });
    await seedMatch(page, { then: RECORD });
    await context.setOffline(true);
    const draftId = await recordClip(page);
    await expect(status(page, 'Waiting to retry.')).toBeVisible();
    await expect(page.getByText('Waiting for an internet connection.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Manual entry / live match' })).toBeVisible();
    expect(ai.calls).toEqual([]);
    expect((await readDatabase(page)).voiceDrafts).toMatchObject([{ id: draftId, state: 'waiting-retry', error: { code: 'offline', phase: 'transcription' }, recording: FAKE_RECORDING }]);

    await context.setOffline(false);
    await page.reload();
    await expect(status(page, 'Waiting to retry.')).toBeVisible();
    await page.getByRole('button', { name: 'Retry processing' }).click();
    await expect(status(page, 'Ready for review.')).toBeVisible();
    expect(ai.calls.map(call => call.kind)).toEqual(['transcription', 'openai-parser']);
    await page.getByRole('button', { name: 'Confirm and add' }).click();
    await expect(page).toHaveURL(new RegExp(`${LIVE}$`));
    const stored = await readDatabase(page);
    expect(stored.games).toHaveLength(2);
    expect(stored.voiceDrafts).toEqual([]);
  });

  const failures: Array<{ name: string; scenario: AiScenario; message: string; phase: 'transcription' | 'parser'; retriedCalls: string[] }> = [
    { name: 'transcription network failure', scenario: { games: 2, transcription: [{ type: 'network' }, { type: 'ok' }] }, message: 'Provider network request failed.', phase: 'transcription', retriedCalls: ['transcription', 'transcription', 'openai-parser'] },
    // A parser failure keeps the transcript, so the retry does not transcribe (or pay for) the audio again.
    { name: 'parser rate limit', scenario: { games: 2, parser: [{ type: 'status', status: 429 }, { type: 'ok' }] }, message: 'Provider rate limit reached.', phase: 'parser', retriedCalls: ['transcription', 'openai-parser', 'openai-parser'] },
  ];
  for (const failure of failures) {
    test(`a ${failure.name} keeps the recording and draft; retry succeeds without duplicate games`, async ({ page }) => {
      const ai = await setUp(page, { scenario: failure.scenario });
      await seedMatch(page, { then: RECORD });
      const draftId = await recordClip(page);
      await expect(status(page, 'Waiting to retry.')).toBeVisible();
      await expect(page.getByText(failure.message)).toBeVisible();
      expect((await readDatabase(page)).voiceDrafts).toMatchObject([{ id: draftId, state: 'waiting-retry', error: { phase: failure.phase }, recording: FAKE_RECORDING }]);

      await page.reload();
      await expect(status(page, 'Waiting to retry.')).toBeVisible();
      const retry = page.getByRole('button', { name: 'Retry processing' });
      await retry.click();
      await expect(status(page, 'Ready for review.')).toBeVisible();
      await expect(retry).toBeHidden();
      expect(ai.calls.map(call => call.kind)).toEqual(failure.retriedCalls);

      await page.getByRole('button', { name: 'Confirm and add' }).click();
      await expect(page).toHaveURL(new RegExp(`${LIVE}$`));
      const stored = await readDatabase(page);
      expect(stored.games).toHaveLength(2);
      expect(new Set(stored.games.map(game => game.ordinal))).toEqual(new Set([1, 2]));
      expect(stored.voiceDrafts).toEqual([]);
    });
  }
});

test.describe('provider secret redaction', () => {
  const cases: Array<{ name: string; scenario: AiScenario; parser?: 'openai' | 'anthropic'; message: string }> = [
    { name: '401 from transcription', scenario: { transcription: { type: 'status', status: 401 } }, message: 'Provider authentication failed.' },
    { name: '401 from the Anthropic parser', scenario: { parser: { type: 'status', status: 401 } }, parser: 'anthropic', message: 'Provider authentication failed.' },
    { name: '429 from the OpenAI parser', scenario: { parser: { type: 'status', status: 429 } }, message: 'Provider rate limit reached.' },
    { name: 'network failure', scenario: { transcription: { type: 'network' } }, message: 'Provider network request failed.' },
    { name: 'malformed transcription response', scenario: { transcription: { type: 'malformed' } }, message: 'Provider returned an invalid response.' },
    { name: 'malformed parser JSON', scenario: { parser: { type: 'malformed' } }, message: 'Provider returned an invalid response.' },
  ];
  const forbidden = [FAKE_API_KEY, /bearer/i, /authorization/i, /x-api-key/i, /received credential/i];
  const leaks = (text: string) => forbidden.filter(pattern => (typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text))).map(String);

  for (const item of cases) {
    test(`a ${item.name} shows a safe error and never exposes the key`, async ({ page }) => {
      const logs: string[] = [];
      page.on('console', message => logs.push(message.text()));
      page.on('pageerror', error => logs.push(`${error.name}: ${error.message}\n${error.stack ?? ''}`));
      const ai = await setUp(page, { scenario: { games: 2, ...item.scenario }, parser: item.parser });
      await seedMatch(page, { then: RECORD });
      await recordClip(page);
      await expect(status(page, 'Waiting to retry.')).toBeVisible();
      await expect(page.getByText(item.message)).toBeVisible();
      // Retrying fails the same way; the error stays safe.
      await page.getByRole('button', { name: 'Retry processing' }).click();
      await expect(status(page, 'Waiting to retry.')).toBeVisible();
      await expect(page.getByText(item.message)).toBeVisible();

      // The key really was sent (so the checks below are meaningful)…
      const sent = ai.calls.filter(call => call.kind !== 'unexpected');
      expect(sent.length).toBeGreaterThanOrEqual(2);
      for (const call of sent) {
        if (call.kind === 'anthropic-parser') expect(call.headers['x-api-key']).toBe(FAKE_API_KEY);
        else expect(call.headers.authorization).toBe(`Bearer ${FAKE_API_KEY}`);
      }
      // …but it never reaches the DOM, the console, or stored drafts/errors.
      expect(leaks(await page.content()), 'DOM').toEqual([]);
      expect(leaks(logs.join('\n')), 'console').toEqual([]);
      const stored = await readDatabase(page);
      expect(stored.voiceDrafts).toHaveLength(1);
      expect(leaks(JSON.stringify(stored)), 'IndexedDB').toEqual([]);
      expect(stored.voiceDrafts[0].error).toEqual({ code: expect.any(String), message: item.message, phase: expect.stringMatching(/^(transcription|parser)$/) });

      // Settings shows only that a key is saved.
      await page.goto('#/settings');
      await expect(page.getByPlaceholder('Key saved').first()).toBeVisible();
      expect(leaks(await page.content()), 'settings DOM').toEqual([]);
    });
  }
});

test.describe('iOS/WebKit microphone fallback to manual entry', () => {
  const retained: SeedDraft = {
    id: 'retained-draft', confirmationId: 'retained-confirmation', matchId: MATCH_ID, setId: SET_ID, dataVersion: 2,
    recording: { type: 'audio/mp4', text: 'EARLIER-AUDIO' }, mimeType: 'audio/mp4', transcripts: [], parsedDraft: null, state: 'waiting-retry',
    error: { code: 'offline', message: 'Waiting for an internet connection.', phase: 'transcription' }, createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
  };
  const variants: Array<{ variant: FakeMicrophoneVariant; message: RegExp; stop?: boolean }> = [
    { variant: 'denied', message: /^Microphone permission was denied or unavailable\. Allow microphone access for this site in your browser or device settings/ },
    { variant: 'unsupported', message: /^Audio recording or its format is not supported on this device\./ },
    { variant: 'format-rejected', message: /^Audio recording or its format is not supported on this device\./ },
    { variant: 'empty', message: /^The recording was empty\. Please try again\./, stop: true },
  ];
  for (const { variant, message, stop } of variants) {
    test(`${variant} microphone: safe message, the saved draft stays recoverable, and manual entry works`, async ({ page }) => {
      const ai = await setUp(page, { microphone: variant });
      await seedMatch(page, { then: RECORD, voiceDrafts: [retained] });
      const before = await readDatabase(page);
      const resume = page.getByRole('link', { name: `Resume draft from ${FIXED_NOW} — waiting to retry` });
      await expect(resume).toBeVisible();

      await page.getByRole('button', { name: 'Start recording' }).click();
      if (stop) await page.getByRole('button', { name: 'Stop recording' }).click();
      await expect(page.getByRole('alert')).toHaveText(message);
      await expect(status(page, 'Recording unavailable.')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Start recording' }), 'recording can be tried again').toBeVisible();
      await expect(page.getByRole('button', { name: 'Retry saving recording' }), 'nothing unsaved to retry').toHaveCount(0);
      const microphone = await fakeMicrophoneState(page);
      if (variant === 'format-rejected' || variant === 'empty') expect(microphone, 'the microphone is released').toMatchObject({ getUserMediaCalls: 1, stoppedTracks: 1 });
      expect(await readDatabase(page), 'the failure writes nothing').toEqual(before);
      expect(ai.calls).toEqual([]);

      // The earlier recording is still recoverable from here…
      await resume.click();
      await expect(status(page, 'Waiting to retry.')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Retry processing' })).toBeEnabled();
      // …and manual entry is one tap away.
      await page.getByRole('link', { name: 'Manual entry / live match' }).click();
      await expect(page).toHaveURL(new RegExp(`${LIVE}$`));
      await page.getByRole('button', { name: 'Manual game entry' }).click();
      const form = page.getByRole('form', { name: 'Manual game entry' });
      await form.getByText('Add details').click();
      await form.getByLabel('Net errors').fill('1');
      await form.getByRole('button', { name: 'Add game' }).click();
      await expect(page.getByText('Set 1: 1–0 (active)')).toBeVisible();
      const after = await readDatabase(page);
      expect(after.games).toMatchObject([{ setId: SET_ID, ordinal: 1, server: 'player', result: 'won', netErrors: 1 }]);
      expect(after.voiceDrafts, 'the retained draft is untouched').toEqual(before.voiceDrafts);
    });
  }

  test('the manual-entry link on the Record page works after a denied microphone', async ({ page }) => {
    await setUp(page, { microphone: 'denied' });
    await seedMatch(page, { then: RECORD });
    await page.getByRole('button', { name: 'Start recording' }).click();
    await expect(page.getByRole('alert')).toContainText('Microphone permission was denied');
    await page.getByRole('link', { name: 'Manual entry', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${LIVE}$`));
    await expect(page.getByRole('button', { name: 'Manual game entry' })).toBeEnabled();
  });
});

test.describe('a recording that cannot be stored stays recoverable', () => {
  // WebKit: Playwright's ephemeral context genuinely rejects Blob writes (as private browsing may). Chromium stores them,
  // so the same rejection is injected there (put() of a draft with a Blob throws DataCloneError, like Safari).
  test.use({ persistentStorage: false });

  test('a failed save keeps the audio on the page with "Retry saving recording", and manual entry still saves games', async ({ page, browserName }) => {
    if (browserName !== 'webkit') {
      await page.addInitScript(() => {
        const put = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
          if ((window as unknown as { __rejectBlobs?: boolean }).__rejectBlobs !== false && value && typeof value === 'object' && (value as { recording?: unknown }).recording instanceof Blob) throw new DOMException('Error preparing Blob/File data to be stored in object store', 'DataCloneError');
          return put.call(this, value, key);
        };
      });
    }
    const ai = await setUp(page);
    await seedMatch(page, { then: RECORD });
    await page.getByRole('button', { name: 'Start recording' }).click();
    await page.getByRole('button', { name: 'Stop recording' }).click();
    await expect(page.getByRole('alert')).toHaveText('The recording could not be saved on this device. It is kept on this page; retry saving before leaving.');
    const retrySave = page.getByRole('button', { name: 'Retry saving recording' });
    await expect(retrySave).toBeVisible();
    await retrySave.click();
    await expect(page.getByRole('alert')).toContainText('could not be saved');
    await expect(retrySave).toBeVisible();
    expect((await readDatabase(page)).voiceDrafts).toEqual([]);
    expect(ai.calls).toEqual([]);

    if (browserName !== 'webkit') {
      // Once storage works again, the SAME in-page audio is saved (one draft) and processed.
      await page.evaluate(() => { (window as unknown as { __rejectBlobs?: boolean }).__rejectBlobs = false; });
      await retrySave.click();
      await expect(page).toHaveURL(/#\/voice\//);
      await expect(status(page, 'Ready for review.')).toBeVisible();
      expect((await readDatabase(page)).voiceDrafts).toMatchObject([{ recording: FAKE_RECORDING }]);
      await page.goto(LIVE);
    } else {
      await page.getByRole('link', { name: 'Manual entry', exact: true }).click();
    }
    await expect(page).toHaveURL(new RegExp(`${LIVE}$`));
    await page.getByRole('button', { name: 'Manual game entry' }).click();
    await page.getByRole('form', { name: 'Manual game entry' }).getByRole('button', { name: 'Add game' }).click();
    await expect(page.getByText('Set 1: 1–0 (active)')).toBeVisible();
    expect((await readDatabase(page)).games).toHaveLength(1);
  });
});

test.describe('a recording save that never settles', () => {
  // Emulates an IndexedDB write that stays pending (Part A saw WebKit leave Blob transactions pending): the put of a
  // draft with a recording is held, with the transaction kept alive, until the test releases it.
  async function holdRecordingWrites(page: Page) {
    await page.addInitScript(() => {
      // Only the first write of a new recording (state 'recorded') is held and counted; later draft updates pass through.
      type Hold = { held: boolean; puts: number };
      const hold: Hold = { held: true, puts: 0 };
      Object.defineProperty(window, '__recordingWrites', { value: hold, configurable: true });
      const put = IDBObjectStore.prototype.put;
      function held(store: IDBObjectStore, value: unknown, key?: IDBValidKey) {
        hold.puts++;
        const proxy = { onsuccess: null as ((event: Event) => void) | null, onerror: null as ((event: Event) => void) | null, result: undefined as unknown, error: null as DOMException | null, readyState: 'pending', source: store, transaction: store.transaction, addEventListener() {}, removeEventListener() {} };
        const spin = () => {
          if (hold.held) { store.count().onsuccess = spin; return; }
          const real = put.call(store, value, key);
          real.onsuccess = event => { proxy.result = real.result; proxy.readyState = 'done'; proxy.onsuccess?.call(real, event); };
          real.onerror = event => { proxy.error = real.error; proxy.readyState = 'done'; proxy.onerror?.call(real, event); };
        };
        spin();
        return proxy as unknown as IDBRequest<IDBValidKey>;
      }
      IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
        const draft = value as { recording?: unknown; state?: unknown } | null;
        if (!(draft && typeof draft === 'object' && draft.recording instanceof Blob && draft.state === 'recorded')) return put.call(this, value, key);
        return held(this, value, key);
      };
    });
  }
  const writes = (page: Page) => page.evaluate(() => (window as unknown as { __recordingWrites: { held: boolean; puts: number } }).__recordingWrites.puts);
  const release = (page: Page) => page.evaluate(() => { (window as unknown as { __recordingWrites: { held: boolean } }).__recordingWrites.held = false; });

  test('stops claiming "Saving…" after a bounded wait, keeps the audio retryable and manual entry reachable, without a duplicate draft', async ({ page }) => {
    await holdRecordingWrites(page);
    await setUp(page);
    await page.clock.install({ time: new Date(FIXED_NOW) });
    await seedMatch(page, { then: RECORD });
    await page.getByRole('button', { name: 'Start recording' }).click();
    await page.getByRole('button', { name: 'Stop recording' }).click();
    await expect(status(page, 'Saving recording…')).toBeVisible();
    expect(await writes(page)).toBe(1);

    await page.clock.fastForward('00:16');
    await expect(page.getByRole('alert')).toHaveText('Saving the recording is taking too long. It is kept on this page; retry saving, or use manual entry.');
    await expect(status(page, 'Recording unavailable.')).toBeVisible();
    const retrySave = page.getByRole('button', { name: 'Retry saving recording' });
    await expect(retrySave).toBeVisible();
    await expect(page.getByRole('link', { name: 'Manual entry', exact: true })).toBeVisible();

    // Retrying waits for the same pending save rather than writing the recording a second time…
    await retrySave.click();
    await expect(status(page, 'Saving recording…')).toBeVisible();
    expect(await writes(page)).toBe(1);
    // …and when storage finally answers, that one draft opens for review.
    await release(page);
    await expect(page).toHaveURL(/#\/voice\/[^/]+$/);
    await expect(status(page, 'Ready for review.')).toBeVisible();
    expect(await writes(page)).toBe(1);
    expect((await readDatabase(page)).voiceDrafts).toMatchObject([{ state: 'ready', recording: FAKE_RECORDING }]);
  });

  test('a save that completes after the timeout still opens its draft once', async ({ page }) => {
    await holdRecordingWrites(page);
    await setUp(page);
    await page.clock.install({ time: new Date(FIXED_NOW) });
    await seedMatch(page, { then: RECORD });
    await page.getByRole('button', { name: 'Start recording' }).click();
    await page.getByRole('button', { name: 'Stop recording' }).click();
    await expect(status(page, 'Saving recording…')).toBeVisible();
    await page.clock.fastForward('00:16');
    await expect(page.getByRole('button', { name: 'Retry saving recording' })).toBeVisible();
    await release(page);
    await expect(page).toHaveURL(/#\/voice\/[^/]+$/);
    await expect(status(page, 'Ready for review.')).toBeVisible();
    expect(await writes(page)).toBe(1);
    expect((await readDatabase(page)).voiceDrafts).toHaveLength(1);
  });
});
