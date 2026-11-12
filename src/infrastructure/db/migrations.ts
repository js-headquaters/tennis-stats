import type { VoiceDraft } from '../../domain/model';
import type { TennisDatabase } from './schema';
export const DATA_VERSION = 2;

const states: ReadonlySet<string> = new Set(['recorded', 'processing', 'waiting-retry', 'ready', 'error', 'confirming']);
const legacyMessage = 'This draft was saved by an earlier version. Retry processing to continue.';

function isRichDraft(row: Record<string, unknown>) {
  return typeof row.state === 'string' && states.has(row.state) && Array.isArray(row.transcripts) && typeof row.confirmationId === 'string' && typeof row.setId === 'string';
}

// Version 1 -> 2: drafts written before the rich draft model ({ transcript, recording? }) become
// retryable rich drafts. Every original field is kept; rich drafts are left untouched (idempotent).
async function migrateLegacyDrafts(db: TennisDatabase) {
  for (const stored of await db.drafts.toArray()) {
    const row = stored as unknown as Record<string, unknown>;
    if (isRichDraft(row)) continue;
    const id = String(row.id); const matchId = typeof row.matchId === 'string' ? row.matchId : '';
    const createdAt = typeof row.createdAt === 'string' ? row.createdAt : '';
    const updatedAt = typeof row.updatedAt === 'string' ? row.updatedAt : createdAt;
    const recording = row.recording instanceof Blob ? row.recording : null;
    const text = typeof row.transcript === 'string' ? row.transcript.trim() : '';
    const set = matchId ? (await db.sets.where('matchId').equals(matchId).toArray()).find(item => item.status === 'active' && item.kind === 'standard') : undefined;
    const migrated: VoiceDraft = {
      ...(row as object),
      id, matchId, setId: set?.id ?? '', confirmationId: `legacy-${id}`, dataVersion: 1,
      recording, mimeType: recording?.type || null,
      transcripts: text ? [{ text, provider: 'legacy', model: 'unknown', timestamp: updatedAt }] : [],
      parsedDraft: null,
      state: text ? 'waiting-retry' : recording ? 'recorded' : 'error',
      error: text ? { code: 'legacy', message: legacyMessage, phase: 'parser' } : recording ? null : { code: 'legacy', message: legacyMessage, phase: 'transcription' },
      createdAt, updatedAt,
    };
    await db.drafts.put(migrated);
  }
}

const migrations: Record<number, (db: TennisDatabase) => Promise<void>> = {
  // Version 0 records already use the initial domain shape.
  0: async () => {},
  1: migrateLegacyDrafts,
};

/** `onStep` is told which step starts, before it runs, so a failure can be reported against that step. */
export type MigrationStepListener = (fromVersion: number, toVersion: number) => void;
export async function runDataMigrations(db: TennisDatabase, fromVersion: number, toVersion: number, onStep?: MigrationStepListener): Promise<void> {
  if (!Number.isInteger(fromVersion) || !Number.isInteger(toVersion) || fromVersion < 0 || toVersion > DATA_VERSION || fromVersion > toVersion) throw new Error('Unsupported data migration version');
  await db.transaction('rw', db.tables, async () => {
    const stored = (await db.metadata.get('dataVersion'))?.value ?? fromVersion;
    if (typeof stored !== 'number') throw new Error('Invalid data version');
    if (stored > toVersion || stored < fromVersion) throw new Error('Unsupported data migration version');
    for (let version = stored; version < toVersion; version++) {
      const migrate = migrations[version];
      onStep?.(version, version + 1);
      if (!migrate) throw new Error(`Missing migration from version ${version}`);
      await migrate(db);
      await db.metadata.put({ key: 'dataVersion', value: version + 1 });
    }
  });
}
