import type { RecoveryCode, SafeDiagnostics } from '../../application/ports';
import { APP_VERSION } from '../appVersion';
import { DATA_VERSION } from './migrations';

/** What openDatabase knew when the startup migration failed. Values only, never the stored rows. */
export interface RecoveryContext {
  /** The stored data version (missing row = 0); null when unknown or not a number. */
  storedDataVersion: number | null;
  /** True when a stored data version exists but is not a number. */
  invalidDataVersion: boolean;
  failedStep: { fromVersion: number; toVersion: number } | null;
}

const STORAGE_ERRORS: ReadonlySet<string> = new Set(['QuotaExceededError']);

/**
 * Error class names that may be reported. Anything else (including identifier-shaped strings that could carry a
 * secret) is reported as `Error`.
 */
const KNOWN_ERROR_NAMES: ReadonlySet<string> = new Set([
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'DOMException',
  // IndexedDB DOMException names and the Dexie error classes that wrap them.
  'AbortError', 'ConstraintError', 'DataError', 'DataCloneError', 'InvalidAccessError', 'InvalidStateError', 'NotFoundError', 'QuotaExceededError',
  'ReadOnlyError', 'TimeoutError', 'TransactionInactiveError', 'UnknownError', 'VersionError',
  'DatabaseClosedError', 'OpenFailedError', 'MissingAPIError', 'InvalidTableError', 'NoSuchDatabaseError', 'PrematureCommitError', 'SchemaError', 'SubTransactionError', 'UpgradeError', 'BulkError', 'ModifyError',
  // The app's own error classes.
  'ReadOnlyRecoveryError', 'DraftStorageError', 'SafeProviderError', 'FileTransferError',
]);

function safeErrorName(error: unknown): string {
  try {
    const name = error instanceof Error || error instanceof DOMException ? error.name : '';
    return KNOWN_ERROR_NAMES.has(name) ? name : 'Error';
  } catch { return 'Error'; }
}

function describe(code: RecoveryCode, context: RecoveryContext): string {
  const step = context.failedStep;
  switch (code) {
    case 'newer-data-version': return 'The saved data was written by a newer version of the app, so this version will not change it.';
    case 'invalid-data-version': return 'The saved data has an unreadable data version, so it was not upgraded.';
    case 'storage-write-failed': return `Device storage refused a write while upgrading saved data${step ? ` from version ${step.fromVersion} to ${step.toVersion}` : ''}. Storage may be full.`;
    case 'migration-step-failed': return `Upgrading saved data from version ${step?.fromVersion} to ${step?.toVersion} failed.`;
    case 'migration-failed': return 'The saved data could not be upgraded for this version of the app.';
  }
}

/**
 * Maps a startup migration failure to secret-free diagnostics. The error's message, stack and cause are never
 * read: the code comes from the known context (stored version, step) and the error class name only.
 */
export const UNKNOWN_CONTEXT: RecoveryContext = { storedDataVersion: null, invalidDataVersion: false, failedStep: null };

export function toSafeDiagnostics(error: unknown, context: RecoveryContext): SafeDiagnostics {
  const errorName = safeErrorName(error);
  const stored = context.storedDataVersion;
  const code: RecoveryCode =
    context.invalidDataVersion ? 'invalid-data-version'
    : stored !== null && stored > DATA_VERSION ? 'newer-data-version'
    : STORAGE_ERRORS.has(errorName) ? 'storage-write-failed'
    : context.failedStep ? 'migration-step-failed'
    : 'migration-failed';
  return { code, message: describe(code, context), failedStep: context.failedStep, storedDataVersion: stored, appDataVersion: DATA_VERSION, appVersion: APP_VERSION, errorName };
}
