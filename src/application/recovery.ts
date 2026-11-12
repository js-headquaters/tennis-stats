/** Shown wherever a write is refused because the database is in read-only recovery mode. */
export const READ_ONLY_MESSAGE = "Changes can't be saved: the app is in read-only recovery mode. Your data is preserved; export a backup from Settings.";

/** Thrown by repository writes while the database is in read-only recovery mode. Its message is safe to show. */
export class ReadOnlyRecoveryError extends Error {
  constructor() { super(READ_ONLY_MESSAGE); this.name = 'ReadOnlyRecoveryError'; }
}

export function isReadOnlyRecoveryError(error: unknown): error is ReadOnlyRecoveryError {
  return error instanceof ReadOnlyRecoveryError;
}
