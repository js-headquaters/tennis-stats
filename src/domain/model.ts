export type Server = 'player' | 'opponent';
export type MatchFormat = 'twoSetsSuperTiebreak' | 'openPractice' | 'oneSet' | 'bestOfThree';
export type MatchStatus = 'active' | 'completed' | 'abandoned';
export type MatchResult = 'won' | 'lost';
export type RecordedMetric = 'netErrors' | 'wideErrors' | 'longErrors' | 'doubleFaults' | 'failedReturns';
export type ValidationIssue = { field: string; message: string };
export type ValidationResult<T> = { ok: true; value: T } | { ok: false; issues: ValidationIssue[] };
export type PersistedEntity = { id: string; createdAt: string; updatedAt: string };
export interface Opponent extends PersistedEntity { name: string; normalizedName: string }
export interface Match extends PersistedEntity { opponentId: string; playedAt: string; format: MatchFormat; firstServer: Server; status: MatchStatus; comments: string | null }
export type SetKind = 'standard' | 'decidingSuperTiebreak';
export type SetStatus = 'active' | 'completed' | 'unfinished';
export interface TennisSet extends PersistedEntity { matchId: string; ordinal: number; kind: SetKind; status: SetStatus; tieBreakId: string | null }
export type GameScore = { player: '0' | '15' | '30' | '40' | 'AD'; opponent: '0' | '15' | '30' | '40' | 'AD' };
export interface Game extends PersistedEntity { setId: string; ordinal: number; server: Server; result: MatchResult; score: GameScore | null; netErrors: number | null; wideErrors: number | null; longErrors: number | null; doubleFaults: number | null; failedReturns: number | null }
export type TieBreakKind = 'standard' | 'super';
export interface TieBreak extends PersistedEntity { setId: string; kind: TieBreakKind; playerPoints: number; opponentPoints: number; netErrors: number | null; wideErrors: number | null; longErrors: number | null; doubleFaults: number | null }
export interface DraftGame { server: Server; result: MatchResult; netErrors: number | null; wideErrors: number | null; longErrors: number | null; doubleFaults: number | null; failedReturns: number | null }
export interface ParsedDraft { version: 1; games: DraftGame[]; warnings: string[] }
export interface VoiceDraft extends PersistedEntity { matchId: string; setId: string; confirmationId: string; dataVersion: 1; recording: Blob | null; mimeType: string | null; transcripts: Array<{ text: string; provider: string; model: string; timestamp: string }>; parsedDraft: ParsedDraft | null; state: 'recorded' | 'processing' | 'waiting-retry' | 'ready' | 'error' | 'confirming'; error: { code: string; message: string } | null }
export interface MatchBundle { match: Match; opponent: Opponent; sets: TennisSet[]; games: Game[]; tieBreaks: TieBreak[] }
export interface DatabaseSnapshot { dataVersion: number; matches: Match[]; opponents: Opponent[]; sets: TennisSet[]; games: Game[]; tieBreaks: TieBreak[]; voiceDrafts: VoiceDraft[] }
