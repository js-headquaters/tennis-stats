// @vitest-environment node
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { isReadOnlyRecoveryError, READ_ONLY_MESSAGE } from '../../application/recovery';
import type { RecoveryStatus, SafeDiagnostics } from '../../application/ports';
import { TennisDatabase } from './schema';
import { openDatabase } from './database';
import { DATA_VERSION } from './migrations';
import { IndexedDbTennisRepository } from './repositories';

const SECRET = 'sk-SENTINEL_SECRET_KEY_123';
const names: string[] = [];
function dbName() { const name = `recovery-${crypto.randomUUID()}`; names.push(name); return name; }
afterEach(async () => {
  for (const name of names.splice(0)) await new Promise<void>((resolve, reject) => { const r = indexedDB.deleteDatabase(name); r.onsuccess = () => resolve(); r.onerror = () => reject(r.error); });
});
async function seed(name: string, dataVersion: unknown | undefined) {
  const db = new TennisDatabase(name); await db.open();
  await db.opponents.put({ id: 'o', name: SECRET, normalizedName: SECRET.toLowerCase(), createdAt: 'old', updatedAt: 'old' });
  if (dataVersion !== undefined) await db.metadata.put({ key: 'dataVersion', value: dataVersion as number });
  db.close();
}
function diagnosticsOf(status: RecoveryStatus): SafeDiagnostics {
  if (status.mode !== 'readOnly') throw new Error('expected read-only recovery');
  return status.diagnostics;
}
const ALLOWED_KEYS = ['appDataVersion', 'appVersion', 'code', 'errorName', 'failedStep', 'message', 'storedDataVersion'];

describe('getRecoveryStatus', () => {
  it.each(['TypeError', 'ConstraintError', 'DatabaseClosedError', 'AbortError'])('reports the known error name %s', async errorName => {
    const name = dbName(); await seed(name, 1);
    const error = errorName === 'TypeError' ? new TypeError(SECRET) : Object.assign(new Error(SECRET), { name: errorName });
    const repo = await openDatabase(name, async () => { throw error; });
    try { expect(diagnosticsOf(repo.getRecoveryStatus()).errorName).toBe(errorName); } finally { repo.close(); }
  });

  it('is normal after a successful open', async () => {
    const repo = await openDatabase(dbName());
    try { expect(repo.getRecoveryStatus()).toEqual({ mode: 'normal' }); } finally { repo.close(); }
  });

  it('reports a failed migration step with safe diagnostics and never leaks the error message, stack or data', async () => {
    const name = dbName(); await seed(name, 1);
    const repo = await openDatabase(name, async (db, _from, _to, onStep) => {
      onStep?.(1, 2);
      const error = new Error(`boom apiKey=${SECRET} record=${JSON.stringify(await db.opponents.toArray())}`);
      error.stack = `Error: ${SECRET}\n    at secret (file.js:1:1)`;
      throw error;
    });
    try {
      const diagnostics = diagnosticsOf(repo.getRecoveryStatus());
      expect(Object.keys(diagnostics).sort()).toEqual(ALLOWED_KEYS);
      expect(diagnostics).toMatchObject({ code: 'migration-step-failed', failedStep: { fromVersion: 1, toVersion: 2 }, storedDataVersion: 1, appDataVersion: DATA_VERSION, errorName: 'Error' });
      expect(diagnostics.message).toMatch(/version 1 to 2/);
      expect(JSON.stringify(diagnostics)).not.toContain('SENTINEL');
      expect(JSON.stringify(diagnostics)).not.toMatch(/apiKey|boom|stack|file\.js/);
    } finally { repo.close(); }
  });

  it('maps a storage quota failure during a step to a storage message', async () => {
    const name = dbName(); await seed(name, 1);
    const repo = await openDatabase(name, async (_db, _from, _to, onStep) => { onStep?.(1, 2); throw new DOMException(`quota ${SECRET}`, 'QuotaExceededError'); });
    try {
      const diagnostics = diagnosticsOf(repo.getRecoveryStatus());
      expect(diagnostics).toMatchObject({ code: 'storage-write-failed', errorName: 'QuotaExceededError', failedStep: { fromVersion: 1, toVersion: 2 } });
      expect(diagnostics.message).toMatch(/storage/i);
      expect(JSON.stringify(diagnostics)).not.toContain('SENTINEL');
    } finally { repo.close(); }
  });

  it('recognises data written by a newer app version through the real migration runner', async () => {
    const name = dbName(); await seed(name, DATA_VERSION + 1);
    const repo = await openDatabase(name);
    try {
      expect(diagnosticsOf(repo.getRecoveryStatus())).toMatchObject({ code: 'newer-data-version', storedDataVersion: DATA_VERSION + 1, appDataVersion: DATA_VERSION, failedStep: null });
      expect(await repo.listOpponents()).toHaveLength(1);
    } finally { repo.close(); }
  });

  it('reports an unreadable stored data version without echoing the stored value', async () => {
    const name = dbName(); await seed(name, SECRET);
    const repo = await openDatabase(name);
    try {
      const diagnostics = diagnosticsOf(repo.getRecoveryStatus());
      expect(diagnostics).toMatchObject({ code: 'invalid-data-version', storedDataVersion: null });
      expect(JSON.stringify(diagnostics)).not.toContain('SENTINEL');
    } finally { repo.close(); }
  });

  it('uses fixed text plus a sanitized error name for unknown failures, even for thrown non-errors', async () => {
    const name = dbName(); await seed(name, undefined);
    const odd = Object.assign(new Error(SECRET), { name: `Weird ${SECRET} name` });
    // Identifier-shaped secrets in `name` must not pass either: only known class names are reported.
    const identifier = Object.assign(new Error('x'), { name: 'sk_abc123' });
    const fakeDom = new DOMException('x', 'sk_live_SECRET');
    for (const thrown of [odd, identifier, fakeDom, { message: SECRET }, SECRET, null]) {
      const repo = await openDatabase(name, async () => { throw thrown; });
      try {
        const diagnostics = diagnosticsOf(repo.getRecoveryStatus());
        expect(diagnostics.code).toBe('migration-failed');
        expect(diagnostics.storedDataVersion).toBe(0);
        expect(diagnostics.errorName).toBe('Error');
        expect(JSON.stringify(diagnostics)).not.toContain('SENTINEL');
        expect(JSON.stringify(diagnostics)).not.toMatch(/sk_/);
      } finally { repo.close(); }
    }
  });

  it('refuses writes with an explanatory read-only error', async () => {
    const name = dbName(); await seed(name, DATA_VERSION + 1);
    const repo = await openDatabase(name);
    try {
      const error = await repo.deleteMatch('x').then(() => null, (reason: unknown) => reason);
      expect(isReadOnlyRecoveryError(error)).toBe(true);
      expect((error as Error).message).toBe(READ_ONLY_MESSAGE);
      expect(READ_ONLY_MESSAGE).toMatch(/read-only recovery mode/i);
      expect(READ_ONLY_MESSAGE).toMatch(/export/i);
    } finally { repo.close(); }
  });

  it('is read-only with generic diagnostics when constructed directly with a recovery error', async () => {
    const name = dbName(); const db = new TennisDatabase(name); await db.open();
    const repo = new IndexedDbTennisRepository(db, new Error(SECRET));
    try { expect(diagnosticsOf(repo.getRecoveryStatus())).toMatchObject({ code: 'migration-failed', failedStep: null, storedDataVersion: null }); } finally { repo.close(); }
  });
});
