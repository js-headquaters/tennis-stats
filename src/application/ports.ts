import type { DatabaseSnapshot, Match, MatchBundle, MatchStatus, Opponent, VoiceDraft } from '../domain/model';

export type AiKind = 'transcription' | 'parser';
export interface TranscriptionSettings { provider: 'openai'; model: string; endpoint: string; apiKey: string }
export interface ParserSettings { provider: 'openai' | 'anthropic'; model: string; endpoint: string; apiKey: string }
export interface AiSettingsStore { getTranscription(): TranscriptionSettings; saveTranscription(settings: TranscriptionSettings): void; getParser(): ParserSettings; saveParser(settings: ParserSettings): void; clear(kind: AiKind): void }
export interface Transcript { text: string; provider: string; model: string }
export interface TranscriptionProvider { transcribe(request: { audio: Blob; mimeType: string; language?: string; context?: string }, signal: AbortSignal): Promise<Transcript> }
export interface ParsedDraft { version: 1; games: Array<{ server: 'player' | 'opponent'; result: 'won' | 'lost'; netErrors: number | null; wideErrors: number | null; longErrors: number | null; doubleFaults: number | null; failedReturns: number | null }>; warnings: string[] }
export interface StatisticsParser { parse(request: { transcript: string; matchContext?: unknown; existingDraft?: ParsedDraft; expectedNext?: unknown }, signal: AbortSignal): Promise<ParsedDraft> }

export interface Clock { now(): string }
export interface IdGenerator { next(): string }
export interface MatchFilter { status?: MatchStatus; opponentId?: string }
export interface TennisRepository {
  readonly recoveryError: unknown | null;
  getActiveMatch(): Promise<MatchBundle | undefined>;
  getMatchBundle(id: string): Promise<MatchBundle | undefined>;
  listMatches(filter?: MatchFilter): Promise<Match[]>;
  saveMatchBundle(bundle: MatchBundle): Promise<void>;
  abandonMatch(id: string, updatedAt: string): Promise<void>;
  deleteMatch(id: string): Promise<void>;
  saveDraft(draft: VoiceDraft): Promise<void>;
  getDraft(id: string): Promise<VoiceDraft | undefined>;
  deleteDraft(id: string): Promise<void>;
  listOpponents(): Promise<Opponent[]>;
  replaceAll(snapshot: DatabaseSnapshot): Promise<void>;
  close(): void;
}
