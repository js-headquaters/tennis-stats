import Dexie, { type Table } from 'dexie';
import type { Game, Match, MatchDiagnostic, Opponent, TennisSet, TieBreak, VoiceDraft } from '../../domain/model';

export class TennisDatabase extends Dexie {
  opponents!: Table<Opponent, string>;
  matches!: Table<Match, string>;
  sets!: Table<TennisSet, string>;
  games!: Table<Game, string>;
  tieBreaks!: Table<TieBreak, string>;
  drafts!: Table<VoiceDraft, string>;
  diagnostics!: Table<MatchDiagnostic, string>;
  metadata!: Table<{ key: string; value: number | { draftId: string; matchId: string; confirmedAt: string } }, string>;
  constructor(name = 'tennis-stats') {
    super(name);
    this.version(1).stores({ opponents: 'id, normalizedName', matches: 'id, status, opponentId, playedAt', sets: 'id, matchId, ordinal', games: 'id, setId, ordinal', tieBreaks: 'id, setId', drafts: 'id, matchId', metadata: 'key' });
    this.version(2).stores({ diagnostics: 'id, matchId, draftId, startedAt' });
  }
}
