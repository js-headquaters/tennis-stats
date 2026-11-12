import type { TennisRepository, MatchFilter } from '../../application/ports';
import type { DatabaseSnapshot, Match, MatchBundle, VoiceDraft } from '../../domain/model';
import { DATA_VERSION } from './migrations';
import type { TennisDatabase } from './schema';

// Stable serialization: object keys are sorted (by code unit, not locale); arrays keep their order.
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().filter(key => (value as Record<string, unknown>)[key] !== undefined).map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}
// Bundle entities are compared by id, so storage order is irrelevant but every field (null vs 0 included) counts.
function bundleSignature(bundle: MatchBundle): string {
  const byId = (items: { id: string }[]) => [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return stable({ match: bundle.match, opponent: bundle.opponent, sets: byId(bundle.sets), games: byId(bundle.games), tieBreaks: byId(bundle.tieBreaks) });
}

function isMarker(value: unknown): value is { draftId: string; matchId: string; confirmedAt: string } {
  if (!value || typeof value !== 'object') return false;
  const marker = value as Record<string, unknown>;
  return typeof marker.draftId === 'string' && !!marker.draftId && typeof marker.matchId === 'string' && !!marker.matchId && typeof marker.confirmedAt === 'string' && !!marker.confirmedAt;
}

export class IndexedDbTennisRepository implements TennisRepository {
  constructor(private db: TennisDatabase, readonly recoveryError: unknown | null, private confirmationHook?: () => void) {}
  private writable() { if (this.recoveryError !== null) throw new Error('Database is in read-only recovery mode'); }
  close() { this.db.close(); }
  async listOpponents() { return this.db.opponents.toArray(); }
  async listMatches(filter: MatchFilter = {}) { return (await this.db.matches.toArray()).filter(m => (!filter.status || m.status === filter.status) && (!filter.opponentId || m.opponentId === filter.opponentId)); }
  async getActiveMatch() {
    return this.db.transaction('r', this.db.matches, this.db.opponents, this.db.sets, this.db.games, this.db.tieBreaks, async () => {
      const match = await this.db.matches.where('status').equals('active').first();
      return match ? this.assembleBundle(match) : undefined;
    });
  }
  async getMatchBundle(id: string): Promise<MatchBundle | undefined> {
    return this.db.transaction('r', this.db.matches, this.db.opponents, this.db.sets, this.db.games, this.db.tieBreaks, async () => {
      const match = await this.db.matches.get(id); if (!match) return undefined;
      return this.assembleBundle(match);
    });
  }
  private async assembleBundle(match: Match): Promise<MatchBundle> {
      const opponent = await this.db.opponents.get(match.opponentId); if (!opponent) throw new Error('Match opponent missing');
      const sets = (await this.db.sets.where('matchId').equals(match.id).toArray()).sort((a, b) => a.ordinal - b.ordinal);
      const ids = sets.map(s => s.id);
      const games = ids.length ? await this.db.games.where('setId').anyOf(ids).toArray() : [];
      const tieBreaks = ids.length ? await this.db.tieBreaks.where('setId').anyOf(ids).toArray() : [];
      const order = new Map(ids.map((id, index) => [id, index]));
      games.sort((a, b) => (order.get(a.setId)! - order.get(b.setId)!) || a.ordinal - b.ordinal);
      tieBreaks.sort((a, b) => order.get(a.setId)! - order.get(b.setId)!);
      return { match, opponent, sets, games, tieBreaks };
  }
  private async removeChildren(id: string) {
    const sets = await this.db.sets.where('matchId').equals(id).toArray();
    const ids = sets.map(s => s.id);
    if (ids.length) { await this.db.games.where('setId').anyOf(ids).delete(); await this.db.tieBreaks.where('setId').anyOf(ids).delete(); await this.db.sets.bulkDelete(ids); }
  }
  async saveMatchBundle(bundle: MatchBundle) {
    this.writable();
    await this.db.transaction('rw', this.db.matches, this.db.opponents, this.db.sets, this.db.games, this.db.tieBreaks, async () => {
      await this.writeBundle(bundle);
    });
  }
  private async writeBundle(bundle: MatchBundle) {
      const { match, opponent, sets, games, tieBreaks } = bundle;
      if (match.opponentId !== opponent.id || sets.some(s => s.matchId !== match.id) || games.some(g => !sets.some(s => s.id === g.setId)) || tieBreaks.some(t => !sets.some(s => s.id === t.setId && s.tieBreakId === t.id)) || sets.some(s => s.tieBreakId !== null && !tieBreaks.some(t => t.id === s.tieBreakId && t.setId === s.id))) throw new Error('Invalid match bundle associations');
      if (match.status === 'active' && (await this.db.matches.where('status').equals('active').toArray()).some(m => m.id !== match.id)) throw new Error('An active match already exists');
      await this.removeChildren(match.id);
      await this.db.opponents.put(opponent); await this.db.matches.put(match);
      await this.db.sets.bulkAdd(sets); await this.db.games.bulkAdd(games); await this.db.tieBreaks.bulkAdd(tieBreaks);
  }
  async confirmDraft(draftId: string, confirmationId: string, bundle: MatchBundle, confirmedAt: string, baseBundle: MatchBundle): Promise<{ status: 'confirmed' | 'alreadyConfirmed' }> {
    this.writable();
    return this.db.transaction('rw', [this.db.matches, this.db.opponents, this.db.sets, this.db.games, this.db.tieBreaks, this.db.drafts, this.db.metadata], async () => {
      const key = `draft-confirmation:${confirmationId}`;
      const marker = (await this.db.metadata.get(key))?.value;
      if (marker !== undefined) {
        if (!isMarker(marker) || marker.draftId !== draftId || marker.matchId !== bundle.match.id) throw new Error('Confirmation marker collision');
        return { status: 'alreadyConfirmed' as const };
      }
      if (!draftId || !confirmationId || !confirmedAt) throw new Error('Invalid draft confirmation');
      const draft = await this.db.drafts.get(draftId);
      const currentMatch = draft && await this.db.matches.get(draft.matchId);
      if (!draft || draft.confirmationId !== confirmationId || draft.matchId !== bundle.match.id || !currentMatch || !baseBundle || baseBundle.match.id !== draft.matchId) throw new Error('Invalid draft confirmation');
      const set = await this.db.sets.get(draft.setId);
      if (!set || set.matchId !== draft.matchId || !bundle.sets.some(s => s.id === draft.setId && s.matchId === draft.matchId)) throw new Error('Invalid draft set');
      for (const item of await this.db.metadata.toArray()) {
        if (!item.key.startsWith('draft-confirmation:')) continue;
        if (!isMarker(item.value)) throw new Error('Invalid confirmation marker');
        if (item.value.draftId === draftId) throw new Error('Draft already confirmed with another marker');
      }
      const current = await this.assembleBundle(currentMatch);
      // The prepared bundle replaces every child row, so it may only be written over the exact state it was prepared from.
      if (bundleSignature(current) !== bundleSignature(baseBundle)) throw new Error('Match changed during confirmation');
      await this.writeBundle(bundle);
      await this.db.metadata.add({ key, value: { draftId, matchId: draft.matchId, confirmedAt } });
      this.confirmationHook?.();
      await this.db.drafts.delete(draftId);
      return { status: 'confirmed' as const };
    });
  }
  async abandonMatch(id: string, updatedAt: string) {
    this.writable();
    await this.db.transaction('rw', this.db.matches, async () => {
      const match = await this.db.matches.get(id);
      if (!match || match.status !== 'active') throw new Error('Match is not active');
      await this.db.matches.put({ ...match, status: 'abandoned', updatedAt });
    });
  }
  async deleteMatch(id: string) { this.writable(); await this.db.transaction('rw', this.db.matches, this.db.sets, this.db.games, this.db.tieBreaks, this.db.drafts, async () => { await this.removeChildren(id); await this.db.drafts.where('matchId').equals(id).delete(); await this.db.matches.delete(id); }); }
  async saveDraft(draft: VoiceDraft) {
    this.writable();
    await this.db.transaction('rw', this.db.matches, this.db.drafts, this.db.metadata, async () => {
      if (!await this.db.matches.get(draft.matchId)) throw new Error('Draft match missing');
      if (await this.getDraftConfirmation(draft.id)) throw new Error('Draft already confirmed');
      await this.db.drafts.put(draft);
    });
  }
  async getDraft(id: string) { return this.db.drafts.get(id); }
  async listDrafts(matchId?: string) { return matchId ? this.db.drafts.where('matchId').equals(matchId).toArray() : this.db.drafts.toArray(); }
  async getDraftConfirmation(draftId: string) {
    let found: { confirmationId: string; matchId: string; confirmedAt: string } | undefined;
    for (const row of await this.db.metadata.toArray()) {
      const prefix = 'draft-confirmation:';
      if (!row.key.startsWith(prefix)) continue;
      const confirmationId = row.key.slice(prefix.length);
      if (!confirmationId || !isMarker(row.value)) throw new Error('Invalid confirmation marker');
      if (row.value.draftId === draftId) {
        if (found) throw new Error('Confirmation marker collision');
        found = { confirmationId, matchId: row.value.matchId, confirmedAt: row.value.confirmedAt };
      }
    }
    return found;
  }
  async deleteDraft(id: string) { this.writable(); await this.db.drafts.delete(id); }
  async replaceAll(snapshot: DatabaseSnapshot) {
    this.writable();
    await this.db.transaction('rw', this.db.tables, async () => {
      if (snapshot.dataVersion !== DATA_VERSION || snapshot.matches.filter(m => m.status === 'active').length > 1) throw new Error('Invalid snapshot');
      const opponents = new Set(snapshot.opponents.map(o => o.id));
      const matches = new Set(snapshot.matches.map(m => m.id));
      const sets = new Map(snapshot.sets.map(s => [s.id, s]));
      const tieBreaks = new Map(snapshot.tieBreaks.map(t => [t.id, t]));
      if (snapshot.matches.some(m => !opponents.has(m.opponentId)) ||
          snapshot.sets.some(s => !matches.has(s.matchId) || (s.tieBreakId !== null && tieBreaks.get(s.tieBreakId)?.setId !== s.id)) ||
          snapshot.games.some(g => !sets.has(g.setId)) ||
          snapshot.tieBreaks.some(t => sets.get(t.setId)?.tieBreakId !== t.id) ||
          snapshot.voiceDrafts.some(d => !matches.has(d.matchId))) throw new Error('Invalid snapshot associations');
      for (const table of this.db.tables) await table.clear();
      await this.db.opponents.bulkAdd(snapshot.opponents); await this.db.matches.bulkAdd(snapshot.matches); await this.db.sets.bulkAdd(snapshot.sets); await this.db.games.bulkAdd(snapshot.games); await this.db.tieBreaks.bulkAdd(snapshot.tieBreaks); await this.db.drafts.bulkAdd(snapshot.voiceDrafts); await this.db.metadata.put({ key: 'dataVersion', value: DATA_VERSION });
    });
  }
}
