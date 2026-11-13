/**
 * Deterministic E2E fixtures shared by every Playwright spec (Task 13 Parts A–C).
 *
 * - Data builders produce real domain records (src/domain/model.ts) with deterministic ids and timestamps.
 * - `seedDatabase` / `readDatabase` talk to the app's REAL IndexedDB (`tennis-stats`, created by Dexie in
 *   src/infrastructure/db/schema.ts). The app creates the schema itself; the fixture only writes rows, so no
 *   production schema/migration logic is duplicated here.
 * - `mockAi` answers OpenAI/Anthropic requests with Playwright routes; nothing ever reaches a paid API.
 * - `installFakeMicrophone` stubs getUserMedia + MediaRecorder before app code runs (Chromium and WebKit).
 * - Only the obviously fake key `FAKE_API_KEY` may appear; fixtures.spec.ts scans for real key shapes.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { test as base, expect, type Page, type Request, type Route } from '@playwright/test';
import { DATA_VERSION } from '../../src/infrastructure/db/migrations';
import type { DatabaseSnapshot, DraftGame, Game, Match, MatchBundle, MatchFormat, MatchResult, Opponent, Server, SetKind, SetStatus, TennisSet, TieBreak, TieBreakKind, VoiceDraft } from '../../src/domain/model';

export const DB_NAME = 'tennis-stats';
/** The app's current data version (src/infrastructure/db/migrations.ts has no runtime imports, so Node can load it). */
export const CURRENT_DATA_VERSION = DATA_VERSION;
/** Fixed wall clock for every spec that depends on "now" (use with `page.clock.setFixedTime`). */
export const FIXED_NOW = '2026-03-14T10:00:00.000Z';
/** The only API key the suite ever uses. Deliberately not shaped like any real provider key. */
export const FAKE_API_KEY = 'test-key-not-real';

/**
 * `test` with one extra option. `persistentStorage: true` runs the test in a persistent browser context (fresh
 * temporary profile per test, same project options). Needed on WebKit whenever a Blob must be stored in IndexedDB
 * (voice-draft recordings): Playwright's ephemeral WebKit contexts behave like private browsing and reject Blob
 * values ("Error preparing Blob/File data to be stored in object store"). Not needed for Chromium.
 */
export const test = base.extend<{ persistentStorage: boolean }>({
  persistentStorage: [false, { option: true }],
  context: async ({ context, persistentStorage, playwright, browserName, launchOptions, baseURL, viewport, userAgent, isMobile, hasTouch, deviceScaleFactor, locale, timezoneId, serviceWorkers, permissions }, use, testInfo) => {
    if (!persistentStorage) { await use(context); return; }
    const dir = testInfo.outputPath('profile'); mkdirSync(dir, { recursive: true });
    const persistent = await playwright[browserName].launchPersistentContext(dir, { ...launchOptions, baseURL, viewport, userAgent, isMobile: browserName === 'firefox' ? undefined : isMobile, hasTouch, deviceScaleFactor, locale, timezoneId, serviceWorkers, permissions });
    try { await use(persistent); } finally { await persistent.close(); rmSync(dir, { recursive: true, force: true }); }
  },
});
export { expect };

// ---------------------------------------------------------------------------------------------------------------
// Data builders
// ---------------------------------------------------------------------------------------------------------------

/** Deterministic id source: `ids('game')()` → `game-1`, `game-2`, … */
export function idSequence(prefix: string) { let n = 0; return () => `${prefix}-${++n}`; }

const other = (server: Server): Server => (server === 'player' ? 'opponent' : 'player');
const stamp = (at?: string) => ({ createdAt: at ?? FIXED_NOW, updatedAt: at ?? FIXED_NOW });

export function buildOpponent(name: string, overrides: Partial<Opponent> = {}): Opponent {
  const trimmed = name.trim();
  return { id: `opponent-${trimmed.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, name: trimmed, normalizedName: trimmed.toLowerCase(), ...stamp(), ...overrides };
}

export function buildMatch(overrides: Partial<Match> & Pick<Match, 'id' | 'opponentId'>): Match {
  return { playedAt: FIXED_NOW, format: 'twoSetsSuperTiebreak', firstServer: 'player', status: 'active', comments: null, ...stamp(), ...overrides };
}

export function buildSet(overrides: Partial<TennisSet> & Pick<TennisSet, 'id' | 'matchId' | 'ordinal'>): TennisSet {
  return { kind: 'standard', status: 'active', tieBreakId: null, ...stamp(), ...overrides };
}

/** All metrics unknown (null) unless given. */
export function buildGame(overrides: Partial<Game> & Pick<Game, 'id' | 'setId' | 'ordinal' | 'server' | 'result'>): Game {
  return { score: null, netErrors: null, wideErrors: null, longErrors: null, doubleFaults: null, failedReturns: null, unforcedErrors: null, comments: null, ...stamp(), ...overrides };
}

export function buildTieBreak(overrides: Partial<TieBreak> & Pick<TieBreak, 'id' | 'setId' | 'kind' | 'playerPoints' | 'opponentPoints'>): TieBreak {
  return { netErrors: null, wideErrors: null, longErrors: null, doubleFaults: null, ...stamp(), ...overrides };
}

/** Parsed draft game for AI scenarios; metrics unknown unless given. */
export function buildDraftGame(overrides: Partial<DraftGame> & Pick<DraftGame, 'server' | 'result'>): DraftGame {
  return { netErrors: null, wideErrors: null, longErrors: null, doubleFaults: null, failedReturns: null, unforcedErrors: null, comments: null, ...overrides };
}

export type GameSpec = 'W' | 'L' | (Partial<Omit<Game, 'id' | 'setId' | 'ordinal'>> & { result: MatchResult });
export interface SetSpec {
  /** 'WWLW…' shorthand or per-game specs. Servers alternate across the whole match from `firstServer` unless given. */
  games?: string | GameSpec[];
  status?: SetStatus;
  kind?: SetKind;
  tieBreak?: { kind?: TieBreakKind; playerPoints: number; opponentPoints: number } & Partial<Pick<TieBreak, 'netErrors' | 'wideErrors' | 'longErrors' | 'doubleFaults'>>;
}
export interface MatchSpec {
  id: string;
  opponent: Opponent | string;
  format?: MatchFormat;
  firstServer?: Server;
  status?: Match['status'];
  playedAt?: string;
  comments?: string | null;
  sets?: SetSpec[];
}

/**
 * Builds a consistent MatchBundle. Ids: `<matchId>-set-<n>`, `<matchId>-s<n>-g<k>`, `<matchId>-s<n>-tb`.
 * The service rotation flips after a completed standard tie-break, like `nextGameServer` in matchService.
 * The builder does not validate scoring: describe the stored state you want (e.g. status 'completed').
 */
export function buildMatchBundle(spec: MatchSpec): MatchBundle {
  const opponent = typeof spec.opponent === 'string' ? buildOpponent(spec.opponent) : spec.opponent;
  const firstServer = spec.firstServer ?? 'player';
  const match = buildMatch({ id: spec.id, opponentId: opponent.id, format: spec.format ?? 'twoSetsSuperTiebreak', firstServer, status: spec.status ?? 'active', playedAt: spec.playedAt ?? FIXED_NOW, comments: spec.comments ?? null });
  const sets: TennisSet[] = []; const games: Game[] = []; const tieBreaks: TieBreak[] = [];
  let server = firstServer;
  (spec.sets ?? [{}]).forEach((setSpec, index) => {
    const ordinal = index + 1;
    const set = buildSet({ id: `${spec.id}-set-${ordinal}`, matchId: spec.id, ordinal, kind: setSpec.kind ?? 'standard', status: setSpec.status ?? 'active' });
    const list: GameSpec[] = typeof setSpec.games === 'string' ? (setSpec.games.split('') as GameSpec[]) : setSpec.games ?? [];
    list.forEach((item, k) => {
      const detail = typeof item === 'string' ? { result: item === 'W' ? 'won' as const : 'lost' as const } : item;
      const game = buildGame({ id: `${spec.id}-s${ordinal}-g${k + 1}`, setId: set.id, ordinal: k + 1, server, ...detail });
      games.push(game); server = other(game.server);
    });
    if (setSpec.tieBreak) {
      const { kind, ...rest } = setSpec.tieBreak;
      const tie = buildTieBreak({ id: `${spec.id}-s${ordinal}-tb`, setId: set.id, kind: kind ?? (set.kind === 'decidingSuperTiebreak' ? 'super' : 'standard'), ...rest });
      tieBreaks.push(tie); set.tieBreakId = tie.id;
      if (tie.kind === 'standard' && set.status === 'completed') server = other(server);
    }
    sets.push(set);
  });
  return { match, opponent, sets, games, tieBreaks };
}

/** Recording in a seed draft: text content becomes a Blob of `type` inside the page. */
export type SeedRecording = { type: string; text: string } | null;
export type SeedDraft = Omit<VoiceDraft, 'recording'> & { recording: SeedRecording };
export interface SeedSnapshot extends Omit<DatabaseSnapshot, 'voiceDrafts'> {
  voiceDrafts: SeedDraft[];
  /** Extra metadata rows (e.g. draft confirmation markers). `dataVersion` comes from `dataVersion`. */
  metadata?: Array<{ key: string; value: unknown }>;
}

/** Combines bundles (opponents deduplicated by id) and drafts into a seed snapshot at the current data version. */
export function buildSnapshot({ bundles = [], opponents = [], voiceDrafts = [], dataVersion = CURRENT_DATA_VERSION, metadata }: { bundles?: MatchBundle[]; opponents?: Opponent[]; voiceDrafts?: SeedDraft[]; dataVersion?: number; metadata?: SeedSnapshot['metadata'] } = {}): SeedSnapshot {
  const byId = new Map<string, Opponent>();
  for (const opponent of [...opponents, ...bundles.map(b => b.opponent)]) byId.set(opponent.id, opponent);
  return {
    dataVersion, opponents: [...byId.values()],
    matches: bundles.map(b => b.match), sets: bundles.flatMap(b => b.sets), games: bundles.flatMap(b => b.games), tieBreaks: bundles.flatMap(b => b.tieBreaks),
    voiceDrafts, metadata,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// IndexedDB seeding / reading (through the app's real database)
// ---------------------------------------------------------------------------------------------------------------

/** Dexie store names in src/infrastructure/db/schema.ts → snapshot keys. */
const STORES = { opponents: 'opponents', matches: 'matches', sets: 'sets', games: 'games', tieBreaks: 'tieBreaks', drafts: 'voiceDrafts', metadata: 'metadata' } as const;

/** True once the app has created the database AND committed its data-version row (openDatabase finished migrating). */
async function databaseReady(page: Page): Promise<boolean> {
  return page.evaluate((name) => new Promise<boolean>(resolve => {
    const request = indexedDB.open(name);
    // A missing database must not be created by the fixture: abort so the app's Dexie schema creates it.
    request.onupgradeneeded = () => request.transaction?.abort();
    request.onerror = () => resolve(false);
    request.onblocked = () => resolve(false);
    request.onsuccess = () => {
      const db = request.result;
      try {
        if (!db.objectStoreNames.contains('metadata')) { db.close(); resolve(false); return; }
        const get = db.transaction('metadata').objectStore('metadata').get('dataVersion');
        get.onsuccess = () => { db.close(); resolve(get.result !== undefined); };
        get.onerror = () => { db.close(); resolve(false); };
      } catch { db.close(); resolve(false); }
    };
  }), DB_NAME);
}

/** Navigates to the app (default route) and waits until its IndexedDB exists and is migrated. */
export async function openAppDatabase(page: Page, route = '#/') {
  await page.goto(route);
  await expect.poll(() => databaseReady(page), { message: 'app database was not created' }).toBe(true);
}

export interface SeedOptions {
  /** Route to open after seeding (a fresh document load). Default `#/`. Pass `null` to stay on the bootstrap page. */
  then?: string | null;
}

/**
 * Replaces the app's database contents with `snapshot`:
 * 1. loads the app so Dexie creates/migrates the real schema, 2. clears every store and writes the rows (plus the
 * `dataVersion` metadata row) in one raw IndexedDB transaction, 3. opens `then` in a fresh document so app code
 * reads the seeded rows (and runs its own migrations when `snapshot.dataVersion` is older).
 */
export async function seedDatabase(page: Page, snapshot: SeedSnapshot, { then = '#/' }: SeedOptions = {}) {
  await openAppDatabase(page);
  await page.evaluate(async ({ name, stores, snapshot }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open(name); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    db.onversionchange = () => db.close();
    const rows: Record<string, unknown[]> = {};
    for (const [store, key] of Object.entries(stores)) {
      if (key === 'metadata') rows[store] = [{ key: 'dataVersion', value: snapshot.dataVersion }, ...(snapshot.metadata ?? [])];
      else if (key === 'voiceDrafts') rows[store] = snapshot.voiceDrafts.map(d => ({ ...d, recording: d.recording ? new Blob([d.recording.text], { type: d.recording.type }) : null }));
      else rows[store] = (snapshot as unknown as Record<string, unknown[]>)[key];
    }
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(Object.keys(stores), 'readwrite');
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(new Error(`seed transaction aborted: ${tx.error?.name ?? 'unknown'} ${tx.error?.message ?? ''}`));
      for (const store of Object.keys(stores)) {
        const os = tx.objectStore(store); os.clear();
        // WebKit can leave the transaction pending after a failed put, so fail fast on the request itself.
        for (const row of rows[store]) { const put = os.put(row); put.onerror = () => { reject(new Error(`seed put into ${store} failed: ${put.error?.name} ${put.error?.message}${store === 'drafts' ? ' (WebKit ephemeral contexts cannot store Blobs in IndexedDB; use test.use({ persistentStorage: true }))' : ''}`)); try { tx.abort(); } catch { /* already finished */ } }; }
      }
    });
    db.close();
  }, { name: DB_NAME, stores: STORES, snapshot });
  if (then !== null) { await page.goto('about:blank'); await page.goto(then); }
}

export type StoredRecording = { size: number; type: string } | null;
export type StoredDraft = Omit<VoiceDraft, 'recording'> & { recording: StoredRecording };
export interface StoredSnapshot extends Omit<DatabaseSnapshot, 'voiceDrafts' | 'dataVersion'> {
  /** `null` when the dataVersion row is missing (or the database does not exist yet). */
  dataVersion: number | null;
  voiceDrafts: StoredDraft[];
  /** Metadata rows other than `dataVersion` (draft confirmation markers). */
  metadata: Array<{ key: string; value: unknown }>;
}

/** Dumps every store of the app database as plain JSON (rows in primary-key order; Blobs reduced to size/type). Page must be on the app origin. */
export async function readDatabase(page: Page): Promise<StoredSnapshot> {
  return page.evaluate(async ({ name, stores }) => {
    const empty = { dataVersion: null, opponents: [], matches: [], sets: [], games: [], tieBreaks: [], voiceDrafts: [], metadata: [] };
    const db = await new Promise<IDBDatabase | null>((resolve, reject) => {
      const r = indexedDB.open(name);
      r.onupgradeneeded = () => r.transaction?.abort();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => (r.error?.name === 'AbortError' ? resolve(null) : reject(r.error));
    });
    if (!db) return empty;
    try {
      const tx = db.transaction(Object.keys(stores), 'readonly');
      const result: Record<string, unknown> = { ...empty };
      await Promise.all(Object.entries(stores).map(([store, key]) => new Promise<void>((resolve, reject) => {
        const request = tx.objectStore(store).getAll();
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const all = request.result as Array<Record<string, unknown>>;
          if (key === 'metadata') {
            result.dataVersion = (all.find(row => row.key === 'dataVersion')?.value as number | undefined) ?? null;
            result.metadata = all.filter(row => row.key !== 'dataVersion');
          } else if (key === 'voiceDrafts') {
            result.voiceDrafts = all.map(row => ({ ...row, recording: row.recording instanceof Blob ? { size: row.recording.size, type: row.recording.type } : null }));
          } else result[key] = all;
          resolve();
        };
      })));
      return result as never;
    } finally { db.close(); }
  }, { name: DB_NAME, stores: STORES });
}

/** Rows sorted by id (code-unit order), for order-independent comparisons with `readDatabase` output. */
export function sortById<T extends { id: string }>(rows: readonly T[]): T[] { return [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)); }

// ---------------------------------------------------------------------------------------------------------------
// AI provider mocks
// ---------------------------------------------------------------------------------------------------------------

export const AI_ENDPOINTS = {
  transcription: 'https://api.openai.com/v1/audio/transcriptions',
  openAiParser: 'https://api.openai.com/v1/chat/completions',
  anthropicParser: 'https://api.anthropic.com/v1/messages',
} as const;

/** One provider reply. `ok` uses the scenario's transcript/games. */
export type AiReply = { type: 'ok' } | { type: 'malformed' } | { type: 'status'; status: number } | { type: 'network' };
export interface AiScenario {
  /** Transcription text returned by the OpenAI transcription mock. */
  transcript?: string;
  /** Parsed games: a count (generated, alternating servers from `firstServer`, all metrics unknown) or explicit games. */
  games?: number | DraftGame[];
  firstServer?: Server;
  warnings?: string[];
  /** Reply per call in order; the last entry repeats. Default `[{ type: 'ok' }]`. */
  transcription?: AiReply | AiReply[];
  parser?: AiReply | AiReply[];
  /** Hold every reply: a number of ms, or 'manual' until `release()` is called. */
  delay?: number | 'manual';
}
export type AiCallKind = 'transcription' | 'openai-parser' | 'anthropic-parser' | 'unexpected';
export interface AiCall { kind: AiCallKind; url: string; method: string; headers: Record<string, string>; body: string | null }
export interface AiMock {
  calls: AiCall[]; release(): void; callsOf(kind: AiCallKind): AiCall[];
  /** Changes the scenario for later calls (e.g. a revised transcript/draft for a voice correction). Reply sequences keep their position. */
  update(patch: Partial<AiScenario>): void;
}

export const aiScenarios = {
  success: (games = 2, extra: Partial<AiScenario> = {}): AiScenario => ({ games, ...extra }),
  malformedJson: (): AiScenario => ({ parser: { type: 'malformed' } }),
  unauthorized: (phase: 'transcription' | 'parser' = 'transcription'): AiScenario => ({ [phase]: { type: 'status', status: 401 } }),
  rateLimited: (phase: 'transcription' | 'parser' = 'parser'): AiScenario => ({ [phase]: { type: 'status', status: 429 } }),
  networkFailure: (): AiScenario => ({ transcription: { type: 'network' }, parser: { type: 'network' } }),
  delayed: (games = 2): AiScenario => ({ games, delay: 'manual' }),
};

export function draftGamesFor(scenario: AiScenario): DraftGame[] {
  if (Array.isArray(scenario.games)) return scenario.games;
  let server = scenario.firstServer ?? 'player';
  return Array.from({ length: scenario.games ?? 2 }, (_, i) => { const game = buildDraftGame({ server, result: i % 2 ? 'lost' : 'won' }); server = other(server); return game; });
}

/**
 * Routes every OpenAI/Anthropic request to deterministic replies shaped exactly like the adapters in
 * src/infrastructure/ai expect. Any other request to those hosts is recorded as 'unexpected' and aborted.
 */
export async function mockAi(page: Page, initial: AiScenario = aiScenarios.success()): Promise<AiMock> {
  const scenario: AiScenario = { ...initial };
  const calls: AiCall[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const counts: Record<string, number> = {};
  const pick = (replies: AiReply | AiReply[] | undefined, kind: string): AiReply => {
    const list = replies === undefined ? [{ type: 'ok' } as const] : Array.isArray(replies) ? replies : [replies];
    const index = counts[kind] = (counts[kind] ?? -1) + 1; // parser calls share one sequence across providers
    return list[Math.min(index, list.length - 1)];
  };
  const parsed = () => JSON.stringify({ version: 2, games: draftGamesFor(scenario), warnings: scenario.warnings ?? [] });
  async function handle(route: Route, request: Request) {
    const url = request.url().split('?')[0];
    const kind: AiCallKind = url === AI_ENDPOINTS.transcription ? 'transcription' : url === AI_ENDPOINTS.openAiParser ? 'openai-parser' : url === AI_ENDPOINTS.anthropicParser ? 'anthropic-parser' : 'unexpected';
    if (request.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers: corsHeaders }); return; }
    calls.push({ kind, url: request.url(), method: request.method(), headers: await request.allHeaders(), body: kind === 'transcription' ? null : request.postData() });
    if (kind === 'unexpected') { await route.abort('blockedbyclient'); return; }
    if (scenario.delay === 'manual') await gate; else if (scenario.delay) await new Promise(resolve => setTimeout(resolve, scenario.delay as number));
    const reply = kind === 'transcription' ? pick(scenario.transcription, 'transcription') : pick(scenario.parser, 'parser');
    if (reply.type === 'network') { await route.abort('failed'); return; }
    // Like real providers, the error body echoes the credential it received, so a UI that surfaced provider text would leak it.
    if (reply.type === 'status') { const credential = request.headers()['authorization'] ?? request.headers()['x-api-key'] ?? ''; await route.fulfill({ status: reply.status, headers: corsHeaders, contentType: 'application/json', body: JSON.stringify({ error: { message: `mocked provider error; received credential: ${credential}` } }) }); return; }
    const content = reply.type === 'malformed' ? '{"version":1,"games":[{' : parsed();
    const body = kind === 'transcription'
      ? (reply.type === 'malformed' ? { unexpected: true } : { text: scenario.transcript ?? 'Game one, I served and won.' })
      : kind === 'openai-parser' ? { id: 'chatcmpl-mock', choices: [{ index: 0, message: { role: 'assistant', content } }] }
        : { id: 'msg-mock', type: 'message', role: 'assistant', content: [{ type: 'text', text: content }] };
    await route.fulfill({ status: 200, headers: corsHeaders, contentType: 'application/json', body: JSON.stringify(body) });
  }
  // A held request whose page reloaded meanwhile can no longer be answered; that is expected, not a test failure.
  await page.route(/^https:\/\/api\.(openai|anthropic)\.com\//, (route, request) => handle(route, request).catch(error => { if (!/already handled|closed|Target|aborted|canceled|cancelled/i.test(String(error))) throw error; }));
  return { calls, release, callsOf: kind => calls.filter(call => call.kind === kind), update: patch => { Object.assign(scenario, patch); } };
}
const corsHeaders = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type, x-api-key, anthropic-version, anthropic-dangerous-direct-browser-access', 'access-control-allow-methods': 'POST, OPTIONS' };

/** Stores AI settings with the fake key before app code runs (localStorage keys of src/infrastructure/settings/localSettings.ts). */
export async function configureAi(page: Page, { parser = 'openai' }: { parser?: 'openai' | 'anthropic' } = {}) {
  const transcription = { provider: 'openai', model: 'gpt-transcribe', endpoint: '', apiKey: FAKE_API_KEY };
  const parserSettings = parser === 'anthropic' ? { provider: 'anthropic', model: 'claude-sonnet-4-5', endpoint: '', apiKey: FAKE_API_KEY } : { provider: 'openai', model: 'gpt-4o-mini', endpoint: '', apiKey: FAKE_API_KEY };
  await page.addInitScript(({ transcription, parserSettings }) => {
    localStorage.setItem('tennis.ai.transcription', JSON.stringify(transcription));
    localStorage.setItem('tennis.ai.parser', JSON.stringify(parserSettings));
  }, { transcription, parserSettings });
}

// ---------------------------------------------------------------------------------------------------------------
// Fake microphone
// ---------------------------------------------------------------------------------------------------------------

/**
 * - `mp4`: iOS Safari-like, only audio/mp4 supported (default).   - `webm`: Chromium-like, only audio/webm;codecs=opus.
 * - `no-format`: isTypeSupported() is always false; the recorder falls back to the browser default (audio/webm blob).
 * - `denied`: getUserMedia rejects with NotAllowedError.            - `unsupported`: no MediaRecorder and no mediaDevices.
 * - `format-rejected`: no listed format is supported and the recorder constructor rejects the default (NotSupportedError).
 * - `empty`: recording works but stop() yields a zero-byte blob (e.g. iOS producing no audio data).
 */
export type FakeMicrophoneVariant = 'mp4' | 'webm' | 'no-format' | 'denied' | 'unsupported' | 'format-rejected' | 'empty';
export interface FakeMicrophoneState { getUserMediaCalls: number; recordersCreated: number; requestedMimeTypes: Array<string | null>; stoppedTracks: number }

/** Installs the stub as an init script (call before the first navigation). Each recording yields a deterministic blob. */
export async function installFakeMicrophone(page: Page, variant: FakeMicrophoneVariant = 'mp4') {
  await page.addInitScript((variant: FakeMicrophoneVariant) => {
    const state = { getUserMediaCalls: 0, recordersCreated: 0, requestedMimeTypes: [] as Array<string | null>, stoppedTracks: 0 };
    Object.defineProperty(window, '__fakeMicrophone', { value: state, configurable: true });
    if (variant === 'unsupported') {
      Object.defineProperty(window, 'MediaRecorder', { value: undefined, configurable: true, writable: true });
      Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
      return;
    }
    const supported = variant === 'mp4' || variant === 'empty' ? ['audio/mp4'] : variant === 'webm' ? ['audio/webm;codecs=opus', 'audio/webm'] : [];
    const fallback = variant === 'mp4' || variant === 'empty' ? 'audio/mp4' : 'audio/webm';
    const mediaDevices = {
      async getUserMedia() {
        state.getUserMediaCalls++;
        if (variant === 'denied') throw new DOMException('Permission denied', 'NotAllowedError');
        const track = { kind: 'audio', readyState: 'live', stop() { if (this.readyState !== 'ended') { this.readyState = 'ended'; state.stoppedTracks++; } } };
        return { getTracks: () => [track], getAudioTracks: () => [track], active: true } as unknown as MediaStream;
      },
    };
    Object.defineProperty(navigator, 'mediaDevices', { value: mediaDevices, configurable: true });
    class FakeMediaRecorder {
      static isTypeSupported(type: string) { return supported.includes(type); }
      state: RecordingState = 'inactive'; mimeType: string;
      ondataavailable: ((event: { data: Blob }) => void) | null = null; onstop: (() => void) | null = null; onerror: (() => void) | null = null;
      private readonly index: number;
      constructor(_stream: MediaStream, options?: { mimeType?: string }) {
        state.requestedMimeTypes.push(options?.mimeType ?? null);
        if (variant === 'format-rejected') throw new DOMException('No supported audio format', 'NotSupportedError');
        this.index = ++state.recordersCreated;
        this.mimeType = options?.mimeType ?? fallback;
      }
      start() { if (this.state !== 'inactive') throw new DOMException('Invalid state', 'InvalidStateError'); this.state = 'recording'; }
      stop() {
        if (this.state === 'inactive') return;
        this.state = 'inactive';
        const data = new Blob(variant === 'empty' ? [] : [`FAKE-AUDIO-${this.index}-`.repeat(32)], { type: this.mimeType });
        setTimeout(() => { this.ondataavailable?.({ data }); this.onstop?.(); }, 0);
      }
    }
    Object.defineProperty(window, 'MediaRecorder', { value: FakeMediaRecorder, configurable: true, writable: true });
  }, variant);
}

export async function fakeMicrophoneState(page: Page): Promise<FakeMicrophoneState | null> {
  return page.evaluate(() => (window as unknown as { __fakeMicrophone?: FakeMicrophoneState }).__fakeMicrophone ?? null);
}

/** Key-shaped patterns that must never appear in fixtures or specs (checked by fixtures.spec.ts). */
export const REAL_KEY_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9_-]{20,}/, // OpenAI-style (incl. sk-proj-…)
  /sk-ant-[A-Za-z0-9_-]{10,}/, // Anthropic-style
  new RegExp(['Bea', 'rer\\s+(?!\\$\\{|', FAKE_API_KEY, ')[A-Za-z0-9._~+/-]{8,}'].join('')), // a literal bearer credential
  /x-api-key['"]?\s*[:=]\s*['"](?!test-key-not-real)[^'"]{8,}/i,
];

