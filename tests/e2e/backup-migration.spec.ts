import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import {
  CURRENT_DATA_VERSION, DB_NAME, FAKE_API_KEY, FIXED_NOW, buildMatchBundle, buildOpponent, buildSnapshot, configureAi, expect,
  readDatabase, seedDatabase, sortById, test, type SeedDraft, type StoredSnapshot,
} from './fixtures';
import type { TennisRecords } from '../../src/domain/model';

// Journeys 11 (export → clear → import replace/merge → verify restored data, invalid files) and 12 (upgrade a seeded
// previous database version without data loss; a failed migration stays in read-only recovery with export available).
// Every backup goes through the real Settings → Data UI: the Export button's download and the file input.

const SETTINGS = '#/settings';
const FILE_NAME = 'tennis-stats-backup-v1-2026-03-14.json'; // FIXED_NOW is 2026-03-14 (UTC)
const ENTITIES = ['opponents', 'matches', 'sets', 'games', 'tieBreaks'] as const;

// ---------------------------------------------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------------------------------------------

const alex = buildOpponent('Alex Example', { createdAt: '2026-02-01T09:00:00.000Z', updatedAt: '2026-02-01T09:00:00.000Z' });
const sam = buildOpponent('Sam Sample');
/** Three matches, two opponents, a standard tie-break, comments, and metrics mixing unknown (null) with explicit 0. */
function populatedBundles() {
  const m1 = buildMatchBundle({
    id: 'm1', opponent: alex, format: 'bestOfThree', status: 'completed', playedAt: '2026-03-01T09:00:00.000Z', comments: 'Windy; "served" well — set 1 went to a tie-break',
    sets: [
      {
        status: 'completed',
        games: [
          { server: 'player', result: 'won', netErrors: 0, wideErrors: null, longErrors: 1, doubleFaults: 0, score: { player: '40', opponent: '30' } },
          { server: 'opponent', result: 'lost', netErrors: 2, wideErrors: 0, failedReturns: 0 },
          ...'WLWLWLWLWL'.split('') as Array<'W' | 'L'>,
        ],
        tieBreak: { playerPoints: 7, opponentPoints: 5, netErrors: 0, wideErrors: null, doubleFaults: 1 },
      },
      { status: 'completed', games: [{ server: 'opponent', result: 'won', failedReturns: null, longErrors: 0 }, 'W', 'W', 'W', 'W', 'W'] },
    ],
  });
  const m2 = buildMatchBundle({ id: 'm2', opponent: sam, format: 'oneSet', status: 'completed', playedAt: '2026-03-05T18:30:00.000Z', comments: null, sets: [{ status: 'unfinished', games: [{ server: 'player', result: 'lost', doubleFaults: 2, netErrors: null }, { server: 'opponent', result: 'won', failedReturns: 0 }] }] });
  const m3 = buildMatchBundle({ id: 'm3', opponent: sam, format: 'twoSetsSuperTiebreak', status: 'active', playedAt: '2026-03-14T09:00:00.000Z', comments: 'Practice', firstServer: 'opponent', sets: [{ games: 'WL' }] });
  return [m1, m2, m3];
}
const SENTINEL_TRANSCRIPT = 'SENTINEL-DRAFT-TRANSCRIPT never belongs in a backup';
const pendingDraft: SeedDraft = {
  id: 'draft-1', matchId: 'm3', setId: 'm3-set-1', confirmationId: 'c-1', dataVersion: 1, recording: null, mimeType: null,
  transcripts: [{ text: SENTINEL_TRANSCRIPT, provider: 'openai', model: 'gpt-transcribe', timestamp: FIXED_NOW }], parsedDraft: null,
  state: 'waiting-retry', error: { code: 'offline', message: 'Waiting for an internet connection.', phase: 'parser' }, createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
};
const marker = { key: 'draft-confirmation:SENTINEL-MARKER', value: { draftId: 'old-draft', matchId: 'm1', confirmedAt: FIXED_NOW } };

function populatedSnapshot() { return buildSnapshot({ bundles: populatedBundles(), voiceDrafts: [pendingDraft], metadata: [marker] }); }
/** Tennis records in id order (the comparison form for readDatabase output). */
function records(source: Pick<StoredSnapshot, typeof ENTITIES[number]> | TennisRecords) {
  return Object.fromEntries(ENTITIES.map(entity => [entity, sortById(source[entity] as Array<{ id: string }>)])) as unknown as TennisRecords;
}
function counts(source: TennisRecords) { return Object.fromEntries(ENTITIES.map(entity => [entity, source[entity].length])); }

// ---------------------------------------------------------------------------------------------------------------
// Settings → Data UI helpers
// ---------------------------------------------------------------------------------------------------------------

async function exportFromUi(page: Page) {
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export backup' }).click()]);
  await expect(page.getByRole('status').filter({ hasText: /^Backup saved as / })).toBeVisible();
  return { name: download.suggestedFilename(), text: readFileSync(await download.path()).toString('utf8') };
}
async function chooseFile(page: Page, name: string, content: string | Buffer) {
  await page.getByLabel('Backup file to import').setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8') });
}
const preview = (page: Page) => page.getByRole('region', { name: 'Import preview' });
const outcome = (page: Page) => page.getByRole('status', { name: 'Import outcome' });
async function importFromUi(page: Page, name: string, content: string, mode: 'merge' | 'replace') {
  await chooseFile(page, name, content);
  await expect(preview(page)).toBeVisible();
  await preview(page).getByRole('button', { name: mode === 'merge' ? 'Merge into current data' : 'Replace current data' }).click();
  await page.getByRole('region', { name: mode === 'merge' ? 'Confirm merge' : 'Confirm replace' }).getByRole('button', { name: mode === 'merge' ? 'Confirm merge' : 'Confirm replace' }).click();
  await expect(outcome(page)).toBeVisible();
  return (await outcome(page).textContent()) ?? '';
}
/** One row of a result/preview table: [Type, ...numbers]. */
async function tableRow(page: Page, caption: string, type: string) {
  return page.locator('table', { has: page.locator('caption', { hasText: caption }) }).getByRole('row', { name: new RegExp(`^${type}\\b`) }).getByRole('cell').allTextContents();
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date(FIXED_NOW));
  await configureAi(page); // a sentinel (fake) API key in local storage that must never reach a backup file
});

// ---------------------------------------------------------------------------------------------------------------
// Journey 11
// ---------------------------------------------------------------------------------------------------------------

test.describe('journey 11: export, clear, import', () => {
  test('@smoke exports a deterministic backup, clears everything with DELETE, and restores it exactly with replace', async ({ page }) => {
    const seeded = populatedSnapshot();
    await seedDatabase(page, seeded, { then: SETTINGS });
    const original = await readDatabase(page);
    expect(counts(original)).toEqual({ opponents: 2, matches: 3, sets: 4, games: 22, tieBreaks: 1 });
    await expect(page.getByText('On this device: 3 matches, 2 opponents, 4 sets, 22 games, 1 tie-break, 1 pending voice draft.')).toBeVisible();

    const file = await exportFromUi(page);
    expect(file.name).toBe(FILE_NAME);
    expect(file.name).toMatch(/^tennis-stats-backup-v1-\d{4}-\d{2}-\d{2}\.json$/);
    await expect(page.getByText(`Backup saved as ${FILE_NAME} (3 matches, 2 opponents).`, { exact: false })).toBeVisible();

    // Human-inspectable, versioned envelope with exactly the tennis records.
    expect(file.text.endsWith('}\n')).toBe(true);
    expect(file.text.split('\n')[1]).toBe('  "format": "tennis-stats-backup",');
    const json = JSON.parse(file.text) as { format: string; version: number; exportedAt: string; data: TennisRecords };
    expect(Object.keys(json)).toEqual(['format', 'version', 'exportedAt', 'data']);
    expect(json).toMatchObject({ format: 'tennis-stats-backup', version: 1, exportedAt: FIXED_NOW });
    expect(Object.keys(json.data)).toEqual(['opponents', 'matches', 'sets', 'games', 'tieBreaks']);
    expect(records(json.data), 'the file holds every tennis record exactly as stored').toEqual(records(original));
    // Canonical order (matches by playedAt; games by set then ordinal), so the bytes do not depend on storage order.
    expect(json.data.matches.map(m => m.id)).toEqual(['m1', 'm2', 'm3']);
    expect(json.data.games.filter(g => g.setId === 'm1-set-1').map(g => g.ordinal)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    // Unknown (null) and an explicit 0 survive as different values.
    const g1 = json.data.games.find(g => g.id === 'm1-s1-g1')!;
    expect(g1).toMatchObject({ netErrors: 0, wideErrors: null, longErrors: 1, doubleFaults: 0, failedReturns: null, score: { player: '40', opponent: '30' } });
    expect(json.data.tieBreaks).toEqual([expect.objectContaining({ id: 'm1-s1-tb', playerPoints: 7, opponentPoints: 5, netErrors: 0, wideErrors: null, doubleFaults: 1 })]);
    expect(json.data.matches.map(m => m.comments)).toEqual(['Windy; "served" well — set 1 went to a tie-break', null, 'Practice']);
    // Never keys, AI settings, drafts, recordings or metadata.
    for (const secret of [FAKE_API_KEY, 'apiKey', 'tennis.ai', 'gpt-transcribe', SENTINEL_TRANSCRIPT, 'draft-1', 'SENTINEL-MARKER', 'voiceDrafts', 'drafts', 'recording', 'metadata', 'dataVersion']) {
      expect(file.text, `the backup must not contain "${secret}"`).not.toContain(secret);
    }

    // Deterministic: exporting the same data again yields the same bytes.
    expect((await exportFromUi(page)).text).toBe(file.text);

    // Clear all data: disabled until DELETE is typed exactly.
    const clear = page.getByRole('button', { name: 'Clear all data' });
    const word = page.getByLabel('Type DELETE to confirm');
    await word.fill('delete');
    await expect(clear).toBeDisabled();
    await word.fill('DELETE');
    await clear.click();
    await expect(page.getByText('All match data on this device was deleted: 3 matches, 2 opponents, 4 sets, 22 games, 1 tie-break, 1 pending voice draft.')).toBeVisible();
    const cleared = await readDatabase(page);
    expect(cleared).toEqual({ dataVersion: CURRENT_DATA_VERSION, opponents: [], matches: [], sets: [], games: [], tieBreaks: [], voiceDrafts: [], metadata: [] });
    expect(await page.evaluate(() => localStorage.getItem('tennis.ai.parser')), 'clearing data leaves AI settings alone').toContain(FAKE_API_KEY);

    // Import with replace.
    await chooseFile(page, file.name, file.text);
    await expect(preview(page)).toContainText('Backup format version 1');
    await expect(preview(page)).toContainText('Nothing has been imported yet.');
    expect(await tableRow(page, 'Records in this file', 'Games')).toEqual(['22', '22', '0']);
    expect((await readDatabase(page)).matches, 'the preview changes nothing').toEqual([]);
    const result = await importFromUi(page, file.name, file.text, 'replace');
    expect(result).toContain('Replace finished.');
    expect(result).toContain('32 records added, 0 skipped, 0 not imported because of conflicts.');

    const restored = await readDatabase(page);
    expect(counts(restored)).toEqual(counts(original));
    expect(records(restored), 'every match, set, game, tie-break and opponent is restored field for field').toEqual(records(original));
    expect(restored.dataVersion).toBe(CURRENT_DATA_VERSION);
    expect(restored.voiceDrafts).toEqual([]);

    // The restored data is what the app shows.
    await page.goto('#/matches');
    await expect(page.getByRole('link', { name: /Alex Example/ })).toHaveCount(1);
    await expect(page.getByRole('link', { name: /Sam Sample/ })).toHaveCount(2);
  });

  test('merge is idempotent: importing the same backup twice adds the missing records once and then skips everything', async ({ page }) => {
    const [m1, m2, m3] = populatedBundles();
    const full = buildSnapshot({ bundles: [m1, m2, m3] });
    await seedDatabase(page, full, { then: SETTINGS });
    const original = await readDatabase(page);
    const file = await exportFromUi(page);

    // Only m2 remains on the device; the merge restores the rest.
    await seedDatabase(page, buildSnapshot({ bundles: [m2] }), { then: SETTINGS });
    let text = await importFromUi(page, file.name, file.text, 'merge');
    expect(text).toContain('Merge finished.');
    expect(text).toContain('27 records added, 5 skipped, 0 not imported because of conflicts.');
    expect(await tableRow(page, 'Import result', 'Matches')).toEqual(['2', '1', '0']);
    const once = await readDatabase(page);
    expect(records(once)).toEqual(records(original));

    await page.reload();
    text = await importFromUi(page, file.name, file.text, 'merge');
    expect(text).toContain('0 records added, 32 skipped, 0 not imported because of conflicts.');
    expect(await readDatabase(page), 'a second merge changes nothing').toEqual(once);
  });

  test('merge reports a divergent record with the same id as a conflict and never overwrites it', async ({ page }) => {
    const bundles = populatedBundles();
    await seedDatabase(page, buildSnapshot({ bundles }), { then: SETTINGS });
    const file = await exportFromUi(page);

    // On the device, m1 was edited after the export and m3 is gone.
    const edited = { ...bundles[0], match: { ...bundles[0].match, comments: 'Edited on this device', updatedAt: '2026-03-14T09:30:00.000Z' } };
    await seedDatabase(page, buildSnapshot({ bundles: [edited, bundles[1]] }), { then: SETTINGS });
    const before = await readDatabase(page);

    await chooseFile(page, file.name, file.text);
    const conflicts = preview(page).getByRole('list', { name: 'Merge conflicts (not imported)' });
    await expect(conflicts).toHaveText('Match m1: A match with this id already exists with different details');
    const text = await importFromUi(page, file.name, file.text, 'merge');
    expect(text).toContain('4 records added, 6 skipped, 22 not imported because of conflicts.');
    await expect(page.getByRole('list', { name: 'Conflicts (not imported)' })).toHaveText('Match m1: A match with this id already exists with different details');

    const after = await readDatabase(page);
    expect(after.matches.find(m => m.id === 'm1'), 'the local edit is kept').toEqual(edited.match);
    expect(records(after).games.filter(g => g.setId.startsWith('m1-')), 'm1 children are untouched').toEqual(records(before).games.filter(g => g.setId.startsWith('m1-')));
    expect(after.matches.map(m => m.id).sort(), 'the non-conflicting match is still imported').toEqual(['m1', 'm2', 'm3']);
  });

  const invalid: Array<{ name: string; content: () => string | Buffer; message: string }> = [
    { name: 'garbage', content: () => 'SENTINEL-GARBAGE{ this is not json', message: "This file can't be imported: The file is not valid JSON, so it is not a Tennis Stats backup. Your current data was not changed." },
    { name: 'wrong version', content: () => JSON.stringify({ format: 'tennis-stats-backup', version: 2, exportedAt: FIXED_NOW, data: { opponents: [], matches: [], sets: [], games: [], tieBreaks: [] } }), message: "This file can't be imported: Unsupported backup version 2. This app can read backup versions 0 and 1. Your current data was not changed." },
    { name: 'unknown legacy version', content: () => JSON.stringify({ dataVersion: 7, opponents: [], matches: [], sets: [], games: [], tieBreaks: [] }), message: "This file can't be imported: Unsupported backup version (legacy data version 7). This app can read backup versions 0 and 1. Your current data was not changed." },
    { name: 'not a backup', content: () => JSON.stringify({ hello: 'SENTINEL-GARBAGE' }), message: "This file can't be imported: The file is not a Tennis Stats backup. Your current data was not changed." },
    { name: 'oversized', content: () => Buffer.alloc(20 * 1024 * 1024 + 1, 0x20), message: "This file can't be imported: That file is larger than 20 MB, so it is not a Tennis Stats backup. Your current data was not changed." },
    { name: 'empty', content: () => '', message: "This file can't be imported: That file is empty. Your current data was not changed." },
  ];
  test('invalid files (garbage, wrong version, not a backup, oversized, empty) show a safe error and leave the data unchanged', async ({ page }) => {
    await seedDatabase(page, populatedSnapshot(), { then: SETTINGS });
    const before = await readDatabase(page);
    for (const item of invalid) {
      await chooseFile(page, `${item.name}.json`, item.content());
      await expect(page.getByRole('alert'), item.name).toHaveText(item.message);
      await expect(preview(page), `${item.name}: no merge/replace offered`).toHaveCount(0);
      expect(await page.content(), `${item.name}: the file content is not echoed`).not.toContain('SENTINEL-GARBAGE');
      expect(await readDatabase(page), `${item.name}: data unchanged`).toEqual(before);
    }
  });

  test('a legacy version-0 backup file is migrated in memory and imported through the UI', async ({ page }) => {
    const legacyText = readFileSync('src/test/fixtures/backup-v0.json', 'utf8');
    const legacy = JSON.parse(legacyText) as TennisRecords & { drafts: unknown[] };
    await seedDatabase(page, buildSnapshot({ bundles: [populatedBundles()[1]] }), { then: SETTINGS });

    await chooseFile(page, 'old-backup.json', legacyText);
    await expect(preview(page)).toContainText('Backup format version 0. Nothing has been imported yet.');
    await expect(preview(page).getByRole('list', { name: 'Warnings' })).toHaveText('1 voice draft in this legacy file is not imported: backups never restore drafts or recordings.');
    const text = await importFromUi(page, 'old-backup.json', legacyText, 'merge');
    expect(text).toContain('4 records added, 0 skipped, 0 not imported');

    const stored = await readDatabase(page);
    for (const entity of ENTITIES) for (const row of legacy[entity]) expect(stored[entity], `${entity} from the v0 file`).toContainEqual(row);
    expect(stored.voiceDrafts, 'legacy drafts are never imported').toEqual([]);
    expect(stored.dataVersion).toBe(CURRENT_DATA_VERSION);
    expect(stored.matches.map(m => m.id).sort()).toEqual(['legacy-match-1', 'm2']);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Journey 12: a REAL previous-version IndexedDB, created before the app ever runs on this origin
// ---------------------------------------------------------------------------------------------------------------

type RawRow = Record<string, unknown> & { recordingText?: { type: string; text: string } };
interface LegacyDatabase { dataVersion: number | null; stores: Partial<Record<'opponents' | 'matches' | 'sets' | 'games' | 'tieBreaks' | 'drafts' | 'metadata', RawRow[]>> }

/**
 * Creates the database exactly as an earlier release left it: Dexie `version(1)` (IndexedDB version 10, the same stores
 * and indexes as src/infrastructure/db/schema.ts — data versions 0 and 1 never changed the physical schema), holding
 * old-shape rows and the old `dataVersion` row (none at data version 0). It runs on a same-origin page that is not the
 * app (the manifest), so the app's first ever open is the upgrade.
 */
async function createLegacyDatabase(page: Page, legacy: LegacyDatabase) {
  await page.goto('manifest.webmanifest');
  await page.evaluate(async ({ name, legacy }) => {
    const schema: Record<string, string[]> = { opponents: ['normalizedName'], matches: ['status', 'opponentId', 'playedAt'], sets: ['matchId', 'ordinal'], games: ['setId', 'ordinal'], tieBreaks: ['setId'], drafts: ['matchId'], metadata: [] };
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 10);
      request.onupgradeneeded = () => {
        for (const [store, indexes] of Object.entries(schema)) {
          const os = request.result.createObjectStore(store, { keyPath: store === 'metadata' ? 'key' : 'id' });
          for (const index of indexes) os.createIndex(index, index);
        }
      };
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(Object.keys(schema), 'readwrite');
      tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error);
      for (const [store, rows] of Object.entries(legacy.stores)) for (const { recordingText, ...row } of rows ?? []) tx.objectStore(store).put(recordingText ? { ...row, recording: new Blob([recordingText.text], { type: recordingText.type }) } : row);
      if (legacy.dataVersion !== null) tx.objectStore('metadata').put({ key: 'dataVersion', value: legacy.dataVersion });
    });
    db.close();
  }, { name: DB_NAME, legacy });
}

// Old shapes are the ones src/infrastructure/db/migrations.test.ts and src/test/fixtures/backup-v0.json use.
const oldOpponent = { id: 'o', name: 'Alex', normalizedName: 'alex', createdAt: '2025-06-01T08:00:00.000Z', updatedAt: '2025-06-01T08:00:00.000Z' };
const oldDone = { id: 'done', opponentId: 'o', playedAt: '2025-06-01T08:00:00.000Z', format: 'oneSet', firstServer: 'player', status: 'completed', comments: 'From the first release', createdAt: 'old', updatedAt: 'old' };
const oldActive = { id: 'm', opponentId: 'o', playedAt: '2026-03-14T09:00:00.000Z', format: 'oneSet', firstServer: 'player', status: 'active', comments: null, createdAt: 'old', updatedAt: 'old' };
const oldSets = [
  { id: 'done-s1', matchId: 'done', ordinal: 1, kind: 'standard', status: 'completed', tieBreakId: 'done-tb', createdAt: 'old', updatedAt: 'old' },
  { id: 's1', matchId: 'm', ordinal: 1, kind: 'standard', status: 'active', tieBreakId: null, createdAt: 'old', updatedAt: 'old' },
];
const oldGames = [
  { id: 'done-g1', setId: 'done-s1', ordinal: 1, server: 'player', result: 'won', score: null, netErrors: 0, wideErrors: null, longErrors: 0, doubleFaults: null, failedReturns: null, createdAt: 'old', updatedAt: 'old' },
  { id: 'done-g2', setId: 'done-s1', ordinal: 2, server: 'opponent', result: 'lost', score: { player: '30', opponent: '40' }, netErrors: null, wideErrors: 3, longErrors: null, doubleFaults: null, failedReturns: 0, createdAt: 'old', updatedAt: 'old' },
  { id: 'g1', setId: 's1', ordinal: 1, server: 'player', result: 'won', score: null, netErrors: 1, wideErrors: 0, longErrors: null, doubleFaults: 0, failedReturns: null, createdAt: 'old', updatedAt: 'old' },
];
const oldTieBreaks = [{ id: 'done-tb', setId: 'done-s1', kind: 'standard', playerPoints: 7, opponentPoints: 3, netErrors: 0, wideErrors: null, longErrors: null, doubleFaults: 0, createdAt: 'old', updatedAt: 'old' }];
const tennisStores = { opponents: [oldOpponent], matches: [oldDone, oldActive], sets: oldSets, games: oldGames, tieBreaks: oldTieBreaks };
const legacyDraft = { id: 'with-transcript', matchId: 'm', transcript: 'Won game, one net error', dataVersion: 1, createdAt: 't1', updatedAt: 't2' };

function expectTennisUnchanged(stored: StoredSnapshot) {
  expect(records(stored)).toEqual(records(tennisStores as unknown as TennisRecords));
}

test.describe('journey 12: upgrading a previous database version', () => {
  test('a data-version-0 database (no version row) is upgraded on first open with no data loss', async ({ page }) => {
    await createLegacyDatabase(page, { dataVersion: null, stores: tennisStores });
    await page.goto('#/matches');
    await expect.poll(async () => (await readDatabase(page)).dataVersion, 'the upgrade committed the current data version').toBe(CURRENT_DATA_VERSION);
    const stored = await readDatabase(page);
    expectTennisUnchanged(stored);
    expect(stored.metadata).toEqual([]);

    // The upgraded data is usable: listed, open for writing (a manual game on the active match is stored).
    await expect(page.getByRole('link', { name: /Alex/ })).toHaveCount(2);
    await page.goto('#/matches/m/live');
    await page.getByRole('button', { name: 'Manual game entry' }).click();
    const form = page.getByRole('form', { name: 'Manual game entry' });
    await form.getByLabel('Result').selectOption({ label: 'Lost' });
    await form.getByRole('button', { name: 'Add game' }).click();
    await expect(form).toBeHidden();
    await expect.poll(async () => (await readDatabase(page)).games.length).toBe(4);
  });

  test.describe('with stored audio', () => {
    test.use({ persistentStorage: true }); // the legacy draft carries a Blob (WebKit ephemeral contexts reject Blobs)
    test('a data-version-1 database with legacy voice drafts is upgraded: drafts become retryable, nothing is lost', async ({ page }) => {
      await createLegacyDatabase(page, {
        dataVersion: 1,
        stores: { ...tennisStores, drafts: [legacyDraft, { id: 'with-audio', matchId: 'm', transcript: '', dataVersion: 1, recordingText: { type: 'audio/mp4', text: 'OLD-AUDIO' }, createdAt: 't1', updatedAt: 't3' }] },
      });
      await page.goto('#/matches/m/record');
      await expect.poll(async () => (await readDatabase(page)).dataVersion).toBe(CURRENT_DATA_VERSION);
      const stored = await readDatabase(page);
      expectTennisUnchanged(stored);
      const drafts = Object.fromEntries(stored.voiceDrafts.map(d => [d.id, d]));
      expect(stored.voiceDrafts).toHaveLength(2);
      expect(drafts['with-transcript']).toMatchObject({ ...legacyDraft, setId: 's1', confirmationId: 'legacy-with-transcript', state: 'waiting-retry', recording: null, transcripts: [{ text: 'Won game, one net error', provider: 'legacy', model: 'unknown', timestamp: 't2' }], error: { code: 'legacy', phase: 'parser' } });
      expect(drafts['with-audio']).toMatchObject({ setId: 's1', state: 'recorded', mimeType: 'audio/mp4', recording: { size: 9, type: 'audio/mp4' }, error: null, transcripts: [] });

      // Both migrated drafts are offered for resuming; the transcript draft explains what to do.
      await expect(page.getByRole('link', { name: /Resume draft/ })).toHaveCount(2);
      await page.goto('#/voice/with-transcript');
      await expect(page.locator('[role="status"]', { hasText: 'Waiting to retry.' })).toBeVisible();
      // The stored legacy message is replaced by the page's generic text for unknown codes (finding, see report).
      await expect(page.getByText('Draft processing failed. Please try again.')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Retry processing' })).toBeEnabled();
      await expect(page.getByText('Won game, one net error')).toBeVisible();
    });
  });

  test.describe('a migration that cannot complete stays in read-only recovery', () => {
    async function expectRecovery(page: Page, before: StoredSnapshot) {
      await page.goto(SETTINGS);
      await expect(page.getByText(/^On this device: 2 matches, 1 opponent, 2 sets, 3 games, 1 tie-break/)).toBeVisible();
      // Export still works and contains the preserved data.
      const file = await exportFromUi(page);
      expect(records((JSON.parse(file.text) as { data: TennisRecords }).data)).toEqual(records(tennisStores as unknown as TennisRecords));
      // Writes are refused; nothing is reset or deleted.
      await page.getByLabel('Type DELETE to confirm').fill('DELETE');
      await page.getByRole('button', { name: 'Clear all data' }).click();
      await expect(page.getByRole('alert')).toHaveText("Couldn't clear data. Nothing was deleted. Try again.");
      await importFromUiExpectingFailure(page, file);
      await page.goto('#/matches/m/live');
      await page.getByRole('button', { name: 'Manual game entry' }).click();
      await page.getByRole('form', { name: 'Manual game entry' }).getByRole('button', { name: 'Add game' }).click();
      await expect(page.getByRole('alert').first()).toBeVisible();
      expect(await readDatabase(page), 'the database is preserved exactly').toEqual(before);
    }
    async function importFromUiExpectingFailure(page: Page, file: { name: string; text: string }) {
      await chooseFile(page, file.name, file.text);
      await preview(page).getByRole('button', { name: 'Replace current data' }).click();
      await page.getByRole('button', { name: 'Confirm replace' }).click();
      await expect(preview(page).getByRole('alert')).toHaveText("Couldn't import the backup. Your current data was not changed. Try again or choose another file.");
    }

    test('a database written by a NEWER app version (data version above the current one) is not touched', async ({ page }) => {
      await createLegacyDatabase(page, { dataVersion: CURRENT_DATA_VERSION + 1, stores: tennisStores });
      await page.goto('#/');
      const before = await readDatabase(page);
      expect(before.dataVersion).toBe(CURRENT_DATA_VERSION + 1);
      await expectRecovery(page, before);
    });

    test('a failing data migration step (the version-0 database keeps no version row) still offers export', async ({ page }) => {
      // Fault injection at the browser API, not in app code: every write to the drafts store fails, so the
      // legacy-draft migration (data version 1 → 2) throws and the whole upgrade transaction rolls back.
      await page.addInitScript(() => {
        const put = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
          if (this.name === 'drafts' && location.hash !== '') throw new DOMException('Injected write failure', 'QuotaExceededError');
          return put.apply(this, args);
        };
      });
      await createLegacyDatabase(page, { dataVersion: null, stores: { ...tennisStores, drafts: [legacyDraft] } });
      await page.goto('#/');
      const before = await readDatabase(page);
      expect(before.dataVersion, 'the failed upgrade rolled back: still data version 0').toBeNull();
      expect(before.voiceDrafts).toEqual([{ ...legacyDraft, recording: null }]);
      await expectRecovery(page, before);
    });
  });
});
