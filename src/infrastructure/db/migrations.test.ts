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
