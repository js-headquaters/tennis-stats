import type { TennisRepository, MatchFilter } from '../../application/ports';
import type { DatabaseSnapshot, MatchBundle, VoiceDraft } from '../../domain/model';
import { DATA_VERSION } from './migrations';
import type { TennisDatabase } from './schema';

export class IndexedDbTennisRepository implements TennisRepository {
  constructor(private db: TennisDatabase, readonly recoveryError: unknown | null) {}
  private writable() { if (this.recoveryError !== null) throw new Error('Database is in read-only recovery mode'); }
  close() { this.db.close(); }
  async listOpponents() { return this.db.opponents.toArray(); }
  async listMatches(filter: MatchFilter = {}) { return (await this.db.matches.toArray()).filter(m => (!filter.status || m.status === filter.status) && (!filter.opponentId || m.opponentId === filter.opponentId)); }
  async getActiveMatch() { const match = await this.db.matches.where('status').equals('active').first(); return match ? this.getMatchBundle(match.id) : undefined; }
  async getMatchBundle(id: string): Promise<MatchBundle | undefined> {
    return this.db.transaction('r', this.db.matches, this.db.opponents, this.db.sets, this.db.games, this.db.tieBreaks, async () => {
      const match = await this.db.matches.get(id); if (!match) return undefined;
      const opponent = await this.db.opponents.get(match.opponentId); if (!opponent) throw new Error('Match opponent missing');
      const sets = (await this.db.sets.where('matchId').equals(id).toArray()).sort((a, b) => a.ordinal - b.ordinal);
      const ids = sets.map(s => s.id);
      const games = ids.length ? await this.db.games.where('setId').anyOf(ids).toArray() : [];
      const tieBreaks = ids.length ? await this.db.tieBreaks.where('setId').anyOf(ids).toArray() : [];
      const order = new Map(ids.map((id, index) => [id, index]));
      games.sort((a, b) => (order.get(a.setId)! - order.get(b.setId)!) || a.ordinal - b.ordinal);
      tieBreaks.sort((a, b) => order.get(a.setId)! - order.get(b.setId)!);
      return { match, opponent, sets, games, tieBreaks };
    });
  }
  private async removeChildren(id: string) {
    const sets = await this.db.sets.where('matchId').equals(id).toArray();
    const ids = sets.map(s => s.id);
    if (ids.length) { await this.db.games.where('setId').anyOf(ids).delete(); await this.db.tieBreaks.where('setId').anyOf(ids).delete(); await this.db.sets.bulkDelete(ids); }
  }
  async saveMatchBundle(bundle: MatchBundle) {
    this.writable();
    await this.db.transaction('rw', this.db.matches, this.db.opponents, this.db.sets, this.db.games, this.db.tieBreaks, async () => {
      const { match, opponent, sets, games, tieBreaks } = bundle;
      if (match.opponentId !== opponent.id || sets.some(s => s.matchId !== match.id) || games.some(g => !sets.some(s => s.id === g.setId)) || tieBreaks.some(t => !sets.some(s => s.id === t.setId && s.tieBreakId === t.id)) || sets.some(s => s.tieBreakId !== null && !tieBreaks.some(t => t.id === s.tieBreakId && t.setId === s.id))) throw new Error('Invalid match bundle associations');
      if (match.status === 'active' && (await this.db.matches.where('status').equals('active').toArray()).some(m => m.id !== match.id)) throw new Error('An active match already exists');
      await this.removeChildren(match.id);
      await this.db.opponents.put(opponent); await this.db.matches.put(match);
      await this.db.sets.bulkAdd(sets); await this.db.games.bulkAdd(games); await this.db.tieBreaks.bulkAdd(tieBreaks);
    });
  }
  async deleteMatch(id: string) { this.writable(); await this.db.transaction('rw', this.db.matches, this.db.sets, this.db.games, this.db.tieBreaks, this.db.drafts, async () => { await this.removeChildren(id); await this.db.drafts.where('matchId').equals(id).delete(); await this.db.matches.delete(id); }); }
  async saveDraft(draft: VoiceDraft) { this.writable(); await this.db.drafts.put(draft); }
  async getDraft(id: string) { return this.db.drafts.get(id); }
  async deleteDraft(id: string) { this.writable(); await this.db.drafts.delete(id); }
  async replaceAll(snapshot: DatabaseSnapshot) {
    this.writable();
    await this.db.transaction('rw', this.db.tables, async () => {
      if (snapshot.dataVersion !== DATA_VERSION || snapshot.matches.filter(m => m.status === 'active').length > 1) throw new Error('Invalid snapshot');
      for (const table of this.db.tables) await table.clear();
      await this.db.opponents.bulkAdd(snapshot.opponents); await this.db.matches.bulkAdd(snapshot.matches); await this.db.sets.bulkAdd(snapshot.sets); await this.db.games.bulkAdd(snapshot.games); await this.db.tieBreaks.bulkAdd(snapshot.tieBreaks); await this.db.drafts.bulkAdd(snapshot.voiceDrafts); await this.db.metadata.put({ key: 'dataVersion', value: DATA_VERSION });
    });
  }
}
