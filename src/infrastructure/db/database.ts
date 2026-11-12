import { TennisDatabase } from './schema';
import { DATA_VERSION, runDataMigrations } from './migrations';
import { IndexedDbTennisRepository } from './repositories';

export async function openDatabase(name = 'tennis-stats', migrate = runDataMigrations): Promise<IndexedDbTennisRepository> {
  const db = new TennisDatabase(name);
  await db.open();
  let recoveryError: unknown | null = null;
  try {
    await db.transaction('rw', db.tables, async () => {
      const version = (await db.metadata.get('dataVersion'))?.value ?? 0;
      await migrate(db, version, DATA_VERSION);
    });
  } catch (error) { recoveryError = error; }
  return new IndexedDbTennisRepository(db, recoveryError);
}
