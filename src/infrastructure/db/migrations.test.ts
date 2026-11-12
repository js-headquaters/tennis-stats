// @vitest-environment node
import 'fake-indexeddb/auto';
import { afterEach, expect, it } from 'vitest';
import { TennisDatabase } from './schema';
import { openDatabase } from './database';
import { runDataMigrations } from './migrations';

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
    const draft = { id: 'd', matchId: 'm', transcript: '', dataVersion: 1, createdAt: 'old', updatedAt: 'old' };
    const writes = [
      () => repo.saveMatchBundle({ match, opponent, sets: [], games: [], tieBreaks: [] }),
      () => repo.deleteMatch('m'), () => repo.saveDraft(draft), () => repo.deleteDraft('d'),
      () => repo.replaceAll({ dataVersion: 1, opponents: [], matches: [], sets: [], games: [], tieBreaks: [], voiceDrafts: [] }),
    ];
    for (const write of writes) await expect(write()).rejects.toThrow(/read.only/i);
    expect(await repo.listOpponents()).toEqual([opponent]);
  } finally { repo.close(); }
});
