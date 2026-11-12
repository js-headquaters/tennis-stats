import type { DatabaseSnapshot, Match, MatchBundle, MatchStatus, Opponent, VoiceDraft } from '../domain/model';

export interface Clock { now(): string }
export interface IdGenerator { next(): string }
export interface MatchFilter { status?: MatchStatus; opponentId?: string }
export interface TennisRepository {
  readonly recoveryError: unknown | null;
  getActiveMatch(): Promise<MatchBundle | undefined>;
  getMatchBundle(id: string): Promise<MatchBundle | undefined>;
  listMatches(filter?: MatchFilter): Promise<Match[]>;
  saveMatchBundle(bundle: MatchBundle): Promise<void>;
  deleteMatch(id: string): Promise<void>;
  saveDraft(draft: VoiceDraft): Promise<void>;
  getDraft(id: string): Promise<VoiceDraft | undefined>;
  deleteDraft(id: string): Promise<void>;
  listOpponents(): Promise<Opponent[]>;
  replaceAll(snapshot: DatabaseSnapshot): Promise<void>;
  close(): void;
}
