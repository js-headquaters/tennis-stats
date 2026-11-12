import type { DatabaseSnapshot, Match, MatchBundle, MatchStatus, Opponent, ParsedDraft, TennisRecords, VoiceDraft } from '../domain/model';
export type { ParsedDraft, DraftGame } from '../domain/model';

export type AiKind = 'transcription' | 'parser';
export interface TranscriptionSettings { provider: 'openai'; model: string; endpoint: string; apiKey: string }
export interface ParserSettings { provider: 'openai' | 'anthropic'; model: string; endpoint: string; apiKey: string }
export interface AiSettingsStore { getTranscription(): TranscriptionSettings; saveTranscription(settings: TranscriptionSettings): void; getParser(): ParserSettings; saveParser(settings: ParserSettings): void; clear(kind: AiKind): void }
export interface Transcript { text: string; provider: string; model: string }
export interface TranscriptionProvider { transcribe(request: { audio: Blob; mimeType: string; language?: string; context?: string }, signal: AbortSignal): Promise<Transcript> }
export interface StatisticsParser { parse(request: { transcript: string; matchContext?: unknown; existingDraft?: ParsedDraft; expectedNext?: unknown }, signal: AbortSignal): Promise<ParsedDraft> }

export interface Clock { now(): string }
export interface IdGenerator { next(): string }
export interface MatchFilter { status?: MatchStatus; opponentId?: string; /** Inclusive ISO instant lower bound on playedAt. */ from?: string; /** Inclusive ISO instant upper bound on playedAt. */ to?: string }
/** Stable, secret-free codes for why the database is in read-only recovery mode. */
export type RecoveryCode = 'newer-data-version' | 'invalid-data-version' | 'storage-write-failed' | 'migration-step-failed' | 'migration-failed';
/**
 * Diagnostics safe to show and copy: fixed texts and version numbers only. Never an error message or stack,
 * record contents, API keys or storage keys.
 */
export interface SafeDiagnostics {
  code: RecoveryCode;
  /** Short fixed human message for `code`. */
  message: string;
  /** The data migration step that failed, when one had started. */
  failedStep: { fromVersion: number; toVersion: number } | null;
  /** Stored data version (a missing row is 0); null when it is not a number. */
  storedDataVersion: number | null;
  /** The data version this app expects. */
  appDataVersion: number;
  appVersion: string | null;
  /** Sanitized error class name (identifier characters only), e.g. `QuotaExceededError`. */
  errorName: string;
}
export type RecoveryStatus = { mode: 'normal' } | { mode: 'readOnly'; diagnostics: SafeDiagnostics };
export interface TennisRepository {
  /** `readOnly` when startup migration failed: every write is refused (with `ReadOnlyRecoveryError`) while reads and export keep working. */
  getRecoveryStatus(): RecoveryStatus;
  getActiveMatch(): Promise<MatchBundle | undefined>;
  getMatchBundle(id: string): Promise<MatchBundle | undefined>;
  listMatches(filter?: MatchFilter): Promise<Match[]>;
  saveMatchBundle(bundle: MatchBundle): Promise<void>;
  abandonMatch(id: string, updatedAt: string): Promise<void>;
  deleteMatch(id: string): Promise<void>;
  saveDraft(draft: VoiceDraft): Promise<void>;
  getDraft(id: string): Promise<VoiceDraft | undefined>;
  listDrafts(matchId?: string): Promise<VoiceDraft[]>;
  getDraftConfirmation(draftId: string): Promise<{ confirmationId: string; matchId: string; confirmedAt: string } | undefined>;
  deleteDraft(id: string): Promise<void>;
  confirmDraft(draftId: string, confirmationId: string, preparedBundle: MatchBundle, confirmedAt: string, baseBundle: MatchBundle): Promise<{ status: 'confirmed' | 'alreadyConfirmed' }>;
  listOpponents(): Promise<Opponent[]>;
  replaceAll(snapshot: DatabaseSnapshot): Promise<void>;
  /** Every stored row of every table, read in one transaction; `dataVersion` is the stored data version. */
  snapshot(): Promise<DatabaseSnapshot>;
  /** Insert-only import in one transaction: never modifies an existing row. Any existing id, broken association, child of a match that is not being inserted, or second active match aborts the whole write. */
  insertRecords(records: TennisRecords): Promise<void>;
  close(): void;
}
