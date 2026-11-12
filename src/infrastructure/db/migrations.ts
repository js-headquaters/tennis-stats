import type { TennisDatabase } from './schema';
export const DATA_VERSION = 1;

export async function runDataMigrations(db: TennisDatabase, fromVersion: number, toVersion: number): Promise<void> {
  if (!Number.isInteger(fromVersion) || !Number.isInteger(toVersion) || fromVersion < 0 || toVersion > DATA_VERSION || fromVersion > toVersion) throw new Error('Unsupported data migration version');
  await db.transaction('rw', db.tables, async () => {
    const stored = (await db.metadata.get('dataVersion'))?.value ?? fromVersion;
    if (stored > toVersion || stored < fromVersion) throw new Error('Unsupported data migration version');
    for (let version = stored; version < toVersion; version++) {
      if (version !== 0) throw new Error(`Missing migration from version ${version}`);
      // Version 0 records already use the initial domain shape.
      await db.metadata.put({ key: 'dataVersion', value: version + 1 });
    }
  });
}
