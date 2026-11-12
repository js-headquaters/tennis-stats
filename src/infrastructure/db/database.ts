import { TennisDatabase } from './schema';
import { DATA_VERSION, runDataMigrations, type MigrationStepListener } from './migrations';
import { IndexedDbTennisRepository } from './repositories';
import type { RecoveryContext } from './recoveryDiagnostics';

type Migrate = (db: TennisDatabase, fromVersion: number, toVersion: number, onStep?: MigrationStepListener) => Promise<void>;

export async function openDatabase(name = 'tennis-stats', migrate: Migrate = runDataMigrations): Promise<IndexedDbTennisRepository> {
  const db = new TennisDatabase(name);
  await db.open();
  let recoveryError: unknown | null = null;
  const context: RecoveryContext = { storedDataVersion: null, invalidDataVersion: false, failedStep: null };
  try {
    await db.transaction('rw', db.tables, async () => {
      const version = (await db.metadata.get('dataVersion'))?.value ?? 0;
      if (typeof version !== 'number') { context.invalidDataVersion = true; throw new Error('Invalid data version'); }
      context.storedDataVersion = version;
      await migrate(db, version, DATA_VERSION, (fromVersion, toVersion) => { context.failedStep = { fromVersion, toVersion }; });
    });
  } catch (error) { recoveryError = error instanceof Error ? error : new Error('Data migration failed', { cause: error }); }
  return new IndexedDbTennisRepository(db, recoveryError, undefined, recoveryError === null ? undefined : context);
}
