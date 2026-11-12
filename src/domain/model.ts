export type Server = 'player' | 'opponent';
export type MatchFormat = 'best-of-3' | 'best-of-5';
export type MatchStatus = 'in-progress' | 'completed' | 'abandoned';
export type RecordedMetric = 'firstServesIn' | 'firstServesTotal' | 'secondServesIn' | 'secondServesTotal' | 'aces' | 'doubleFaults' | 'winners' | 'unforcedErrors' | 'failedReturns';
export type ValidationIssue = { field: string; message: string };
export type ValidationResult<T> = { ok: true; value: T } | { ok: false; issues: ValidationIssue[] };
export type PersistedEntity = { id: string; createdAt: string; updatedAt: string };
export interface Opponent extends PersistedEntity { name: string }
export interface Match extends PersistedEntity { opponentId: string; format: MatchFormat; status: MatchStatus; dataVersion: number }
export interface TennisSet extends PersistedEntity { matchId: string; ordinal: number; playerGames: number; opponentGames: number; tieBreakId: string | null }
export type GameScore = { player: '0' | '15' | '30' | '40' | 'AD'; opponent: '0' | '15' | '30' | '40' | 'AD' };
export interface Game extends PersistedEntity { setId: string; ordinal: number; server: Server; score: GameScore | null; firstServesIn: number | null; firstServesTotal: number | null; secondServesIn: number | null; secondServesTotal: number | null; aces: number | null; doubleFaults: number | null; winners: number | null; unforcedErrors: number | null; failedReturns: number | null }
export interface TieBreak extends PersistedEntity { setId: string; ordinal: number; playerPoints: number; opponentPoints: number }
export interface VoiceDraft extends PersistedEntity { matchId: string; transcript: string; status: 'pending' | 'accepted' | 'rejected' }
export interface MatchBundle { match: Match; opponent: Opponent; sets: TennisSet[]; games: Game[]; tieBreaks: TieBreak[] }
export interface DatabaseSnapshot { dataVersion: number; matches: Match[]; opponents: Opponent[]; sets: TennisSet[]; games: Game[]; tieBreaks: TieBreak[]; voiceDrafts: VoiceDraft[] }
