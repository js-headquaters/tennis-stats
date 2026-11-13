// @vitest-environment node
import 'fake-indexeddb/auto';
import { afterEach, expect, it } from 'vitest';
import { TennisDatabase } from './schema';
import { openDatabase } from './database';
import { DATA_VERSION, runDataMigrations } from './migrations';

const name = `migration-${crypto.randomUUID()}`;
afterEach(async () => { await new Promise<void>((resolve, reject) => { const r = indexedDB.deleteDatabase(name); r.onsuccess = () => resolve(); r.onerror = () => reject(r.error); }); });
it('migrates a version 0 fixture transactionally and is idempotent on reopen', async () => {
  const db = new TennisDatabase(name); await db.open();
  await db.opponents.put({ id: 'o', name: 'Alex', normalizedName: 'alex', createdAt: 'old', updatedAt: 'old' });
  await runDataMigrations(db, 0, 1); await runDataMigrations(db, 0, 1);
  expect((await db.metadata.get('dataVersion'))?.value).toBe(1); db.close();
  const repo = await openDatabase(name);
  expect(await repo.listOpponents()).toHaveLength(1); repo.close();
});
it('preserves original data and enters read-only recovery on migration failure', async () => {
  const db = new TennisDatabase(name); await db.open();
  await db.opponents.put({ id: 'o', name: 'Alex', normalizedName: 'alex', createdAt: 'old', updatedAt: 'old' }); db.close();
  const repo = await openDatabase(name, async db => { await db.opponents.clear(); throw new Error('migration failed'); });
  expect(repo.recoveryError).toBeDefined();
  expect(await repo.listOpponents()).toHaveLength(1);
  await expect(repo.deleteMatch('x')).rejects.toThrow(/read.only/i);
  repo.close();
});
it('treats a null migration throw as recovery and rejects every write', async () => {
  const db = new TennisDatabase(name); await db.open();
  const opponent = { id: 'o', name: 'Alex', normalizedName: 'alex', createdAt: 'old', updatedAt: 'old' };
  await db.opponents.put(opponent); db.close();
  const repo = await openDatabase(name, async db => { await db.opponents.clear(); throw null; });
  try {
    expect(repo.recoveryError).toBeInstanceOf(Error);
    expect(await repo.listOpponents()).toEqual([opponent]);
    const match = { id: 'm', opponentId: 'o', playedAt: 'old', format: 'oneSet' as const, firstServer: 'player' as const, status: 'active' as const, comments: null, createdAt: 'old', updatedAt: 'old' };
    const draft = { id: 'd', matchId: 'm', setId: 's', confirmationId: 'c', dataVersion: 2 as const, recording: null, mimeType: null, transcripts: [], parsedDraft: null, state: 'recorded' as const, error: null, createdAt: 'old', updatedAt: 'old' };
    const writes = [
      () => repo.saveMatchBundle({ match, opponent, sets: [], games: [], tieBreaks: [] }),
      () => repo.deleteMatch('m'), () => repo.saveDraft(draft), () => repo.deleteDraft('d'),
      () => repo.confirmDraft('d', 'c', { match, opponent, sets: [], games: [], tieBreaks: [] }, 'now', { match, opponent, sets: [], games: [], tieBreaks: [] }),
      () => repo.replaceAll({ dataVersion: DATA_VERSION, opponents: [], matches: [], sets: [], games: [], tieBreaks: [], voiceDrafts: [] }),
    ];
    for (const write of writes) await expect(write()).rejects.toThrow(/read.only/i);
    expect(await repo.listOpponents()).toEqual([opponent]);
  } finally { repo.close(); }
});
const legacyMatch = { id: 'm', opponentId: 'o', playedAt: 'old', format: 'oneSet' as const, firstServer: 'player' as const, status: 'active' as const, comments: null, createdAt: 'old', updatedAt: 'old' };
const legacySets = [
  { id: 's1', matchId: 'm', ordinal: 1, kind: 'standard' as const, status: 'completed' as const, tieBreakId: null, createdAt: 'old', updatedAt: 'old' },
  { id: 's2', matchId: 'm', ordinal: 2, kind: 'standard' as const, status: 'active' as const, tieBreakId: null, createdAt: 'old', updatedAt: 'old' },
];
const richDraft = { id: 'rich', matchId: 'm', setId: 's2', confirmationId: 'rc', dataVersion: 2 as const, recording: null, mimeType: null, transcripts: [], parsedDraft: null, state: 'ready' as const, error: null, createdAt: 'old', updatedAt: 'old' };
async function seedLegacy() {
  const db = new TennisDatabase(name); await db.open();
  await db.opponents.put({ id: 'o', name: 'Alex', normalizedName: 'alex', createdAt: 'old', updatedAt: 'old' });
  await db.matches.put(legacyMatch); await db.sets.bulkPut(legacySets);
  await db.metadata.put({ key: 'dataVersion', value: 1 });
  // Version-1 drafts written before the rich draft model (transcript string, optional recording, no state).
  const legacy = [
    { id: 'with-transcript', matchId: 'm', transcript: 'Won game, one net error', dataVersion: 1, createdAt: 't1', updatedAt: 't2' },
    { id: 'with-audio', matchId: 'm', transcript: '', dataVersion: 1, recording: new Blob(['audio'], { type: 'audio/mp4' }), createdAt: 't1', updatedAt: 't3' },
    { id: 'empty', matchId: 'gone', transcript: '', dataVersion: 1, recording: null, createdAt: 't1', updatedAt: 't4' },
  ];
  await db.drafts.bulkPut(legacy as never); await db.drafts.put(richDraft);
  return db;
}
it('migrates legacy version-1 drafts to the rich draft shape without losing data, idempotently', async () => {
  const db = await seedLegacy();
  await runDataMigrations(db, 1, DATA_VERSION);
  const once = await db.drafts.toArray();
  await runDataMigrations(db, 1, DATA_VERSION); await runDataMigrations(db, DATA_VERSION, DATA_VERSION);
  expect(await db.drafts.toArray()).toEqual(once);
  expect((await db.metadata.get('dataVersion'))?.value).toBe(DATA_VERSION);
  const byId = Object.fromEntries(once.map(d => [d.id, d]));
  expect(once).toHaveLength(4);
  expect(byId.rich).toEqual(richDraft);
  expect(byId['with-transcript']).toMatchObject({ matchId: 'm', setId: 's2', confirmationId: 'legacy-with-transcript', dataVersion: 2, recording: null, mimeType: null, parsedDraft: null, state: 'waiting-retry', error: { phase: 'parser' }, createdAt: 't1', updatedAt: 't2', transcripts: [{ text: 'Won game, one net error', provider: 'legacy', model: 'unknown', timestamp: 't2' }] });
  expect(byId['with-audio']).toMatchObject({ setId: 's2', state: 'recorded', error: null, transcripts: [], mimeType: 'audio/mp4' });
  expect(byId['with-audio'].recording).toBeInstanceOf(Blob);
  expect(byId.empty).toMatchObject({ matchId: 'gone', setId: '', state: 'error', transcripts: [], recording: null });
  db.close();
  const repo = await openDatabase(name);
  try { expect(repo.recoveryError).toBeNull(); expect(await repo.listDrafts('m')).toHaveLength(3); } finally { repo.close(); }
});
it('upgrades a legacy version-1 database through openDatabase', async () => {
  (await seedLegacy()).close();
  const repo = await openDatabase(name);
  try {
    expect(repo.recoveryError).toBeNull();
    expect((await repo.getDraft('with-transcript'))?.state).toBe('waiting-retry');
    expect(await repo.listOpponents()).toHaveLength(1); expect((await repo.getMatchBundle('m'))?.sets).toHaveLength(2);
  } finally { repo.close(); }
});

const oldGame = { id: 'g1', setId: 's1', ordinal: 1, server: 'player', result: 'won', score: { player: '40', opponent: '15' }, netErrors: 1, wideErrors: 2, longErrors: 0, doubleFaults: null, failedReturns: null, createdAt: 'old', updatedAt: 'old' };
const oldDraftGame = { server: 'opponent', result: 'lost', netErrors: 3, wideErrors: null, longErrors: 1, doubleFaults: null, failedReturns: 2 };
const v2Draft = (id: string, parsedDraft: unknown) => ({ id, matchId: 'm', setId: 's2', confirmationId: `c-${id}`, dataVersion: 1, recording: null, mimeType: null, transcripts: [{ text: 'hi', provider: 'p', model: 'm', timestamp: 't' }], parsedDraft, state: 'ready', error: null, createdAt: 'old', updatedAt: 'old' });
async function seedVersion2() {
  const db = new TennisDatabase(name); await db.open();
  await db.opponents.put({ id: 'o', name: 'Alex', normalizedName: 'alex', createdAt: 'old', updatedAt: 'old' });
  await db.matches.put(legacyMatch); await db.sets.bulkPut(legacySets);
  await db.games.bulkPut([oldGame, { ...oldGame, id: 'g2', ordinal: 2, unforcedErrors: 7, comments: 'kept' }] as never);
  await db.drafts.bulkPut([
    v2Draft('rich', { version: 1, games: [oldDraftGame, { ...oldDraftGame, unforcedErrors: 4, comments: 'mine' }], warnings: ['w'] }),
    v2Draft('none', null),
  ] as never);
  await db.metadata.put({ key: 'dataVersion', value: 2 });
  return db;
}
it('migrates version 2 games and drafts to totals and comments, preserving fields and idempotently', async () => {
  expect(DATA_VERSION).toBe(3);
  const db = await seedVersion2();
  await runDataMigrations(db, 2, DATA_VERSION);
  const games = await db.games.orderBy('ordinal').toArray();
  expect(games[0]).toEqual({ ...oldGame, unforcedErrors: null, comments: null });
  expect(games[1]).toEqual({ ...oldGame, id: 'g2', ordinal: 2, unforcedErrors: 7, comments: 'kept' });
  const drafts = Object.fromEntries((await db.drafts.toArray()).map(d => [d.id, d]));
  expect(drafts.rich).toMatchObject({ dataVersion: 2, confirmationId: 'c-rich', state: 'ready', transcripts: [{ text: 'hi' }] });
  expect(drafts.rich.parsedDraft).toEqual({ version: 2, warnings: ['w'], games: [{ ...oldDraftGame, unforcedErrors: null, comments: null }, { ...oldDraftGame, unforcedErrors: 4, comments: 'mine' }] });
  expect(drafts.none).toMatchObject({ dataVersion: 2, parsedDraft: null });
  const once = { games: await db.games.toArray(), drafts: await db.drafts.toArray() };
  await runDataMigrations(db, 2, DATA_VERSION); await runDataMigrations(db, DATA_VERSION, DATA_VERSION);
  expect({ games: await db.games.toArray(), drafts: await db.drafts.toArray() }).toEqual(once);
  expect((await db.metadata.get('dataVersion'))?.value).toBe(3);
  db.close();
});
