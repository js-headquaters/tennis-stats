// @vitest-environment node
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import type { MatchBundle, DatabaseSnapshot } from '../../domain/model';
import { openDatabase } from './database';

const stamp = { createdAt: '2026-01-01', updatedAt: '2026-01-01' };
const bundle = (id: string, status: 'active' | 'completed' = 'active'): MatchBundle => ({
  opponent: { ...stamp, id: 'o', name: 'Alex', normalizedName: 'alex' },
  match: { ...stamp, id, opponentId: 'o', playedAt: stamp.createdAt, format: 'oneSet', firstServer: 'player', status, comments: null },
  sets: [{ ...stamp, id: `${id}-s2`, matchId: id, ordinal: 2, kind: 'standard', status: 'active', tieBreakId: null }, { ...stamp, id: `${id}-s1`, matchId: id, ordinal: 1, kind: 'standard', status: 'completed', tieBreakId: `${id}-t` }],
  games: [2, 1].map(ordinal => ({ ...stamp, id: `${id}-g${ordinal}`, setId: `${id}-s1`, ordinal, server: 'player', result: 'won', score: null, netErrors: 0, wideErrors: null, longErrors: null, doubleFaults: null, failedReturns: null })),
  tieBreaks: [{ ...stamp, id: `${id}-t`, setId: `${id}-s1`, kind: 'standard', playerPoints: 7, opponentPoints: 0, netErrors: null, wideErrors: 0, longErrors: null, doubleFaults: null }],
});
let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanup.map(fn => fn())); cleanup = []; });
async function setup() {
  const name = `repo-${crypto.randomUUID()}`;
  const repo = await openDatabase(name);
  cleanup.push(async () => { repo.close(); await indexedDBDelete(name); });
  return repo;
}
function indexedDBDelete(name: string) { return new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase(name); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); }); }

describe('IndexedDB repository', () => {
  it('round trips ordered bundles with nulls, zeroes and reusable opponents', async () => {
    const repo = await setup();
    await repo.saveMatchBundle(bundle('m'));
    const found = await repo.getMatchBundle('m');
    expect(found?.sets.map(s => s.ordinal)).toEqual([1, 2]);
    expect(found?.games.map(g => g.ordinal)).toEqual([1, 2]);
    expect(found?.games[0]).toMatchObject({ netErrors: 0, wideErrors: null });
    expect(found?.tieBreaks[0]).toMatchObject({ setId: 'm-s1', opponentPoints: 0, netErrors: null });
    expect(await repo.listOpponents()).toEqual([bundle('m').opponent]);
    expect((await repo.getActiveMatch())?.match.id).toBe('m');
  });
  it('enforces one active match atomically, including concurrent writes', async () => {
    const repo = await setup();
    const results = await Promise.allSettled([repo.saveMatchBundle(bundle('a')), repo.saveMatchBundle(bundle('b'))]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(await repo.listMatches()).toHaveLength(1);
    expect(await repo.listOpponents()).toHaveLength(1);
  });
  it('does not delegate active reads across a deletion gap', async () => {
    const repo = await setup(); await repo.saveMatchBundle(bundle('m'));
    const originalGetBundle = repo.getMatchBundle.bind(repo);
    // Force a deletion into the former gap between active lookup and bundle lookup.
    repo.getMatchBundle = async id => { await repo.deleteMatch(id); return originalGetBundle(id); };
    const active = await repo.getActiveMatch();
    expect(active?.match).toMatchObject({ id: 'm', status: 'active' });
    expect(active?.sets).toHaveLength(2);
  });
  it('serializes a competing delete after an active bundle read', async () => {
    const repo = await setup(); await repo.saveMatchBundle(bundle('m'));
    const reading = repo.getActiveMatch();
    const deletion = repo.deleteMatch('m');
    const [active] = await Promise.all([reading, deletion]);
    expect(active?.match).toMatchObject({ id: 'm', status: 'active' });
    expect(active?.sets).toHaveLength(2);
    expect(await repo.getActiveMatch()).toBeUndefined();
  });
  it('replaces children and deletes a match without deleting its opponent', async () => {
    const repo = await setup(); const original = bundle('m');
    await repo.saveMatchBundle(original);
    await repo.saveMatchBundle({ ...original, sets: [], games: [], tieBreaks: [] });
    expect(await repo.getMatchBundle('m')).toMatchObject({ sets: [], games: [], tieBreaks: [] });
    await repo.deleteMatch('m');
    expect(await repo.getMatchBundle('m')).toBeUndefined();
    expect(await repo.listOpponents()).toHaveLength(1);
  });
  it('persists pending recording blobs', async () => {
    const repo = await setup(); const recording = new Blob(['audio'], { type: 'audio/webm' });
    await repo.saveMatchBundle(bundle('m'));
    await repo.saveDraft({ ...stamp, id: 'd', matchId: 'm', transcript: '', dataVersion: 1, recording });
    const draft = await repo.getDraft('d');
    expect(await draft?.recording?.text()).toBe('audio');
    expect(draft?.recording?.type).toBe('audio/webm');
    await repo.deleteDraft('d'); expect(await repo.getDraft('d')).toBeUndefined();
  });
  it('rejects drafts without a parent, including saves queued after deletion', async () => {
    const repo = await setup();
    const draft = { ...stamp, id: 'd', matchId: 'm', transcript: '', dataVersion: 1 };
    await expect(repo.saveDraft(draft)).rejects.toThrow();
    await repo.saveMatchBundle(bundle('m'));
    await repo.saveDraft(draft);
    const deletion = repo.deleteMatch('m');
    const saving = repo.saveDraft(draft);
    await deletion;
    await expect(saving).rejects.toThrow();
    expect(await repo.getDraft('d')).toBeUndefined();
  });
  it('rejects invalid replacement without disturbing existing data', async () => {
    const repo = await setup(); await repo.saveMatchBundle(bundle('original'));
    const a = bundle('a'); const b = bundle('b');
    const snapshot: DatabaseSnapshot = { dataVersion: 1, opponents: [a.opponent], matches: [a.match, b.match], sets: [], games: [], tieBreaks: [], voiceDrafts: [] };
    await expect(repo.replaceAll(snapshot)).rejects.toThrow();
    expect((await repo.getActiveMatch())?.match.id).toBe('original');
  });
  it.each(['opponent', 'set parent', 'game parent', 'tie-break parent', 'tie-break link', 'missing tie-break', 'draft parent'])('rejects a replacement with broken %s integrity', async broken => {
    const repo = await setup(); await repo.saveMatchBundle(bundle('original'));
    const item = bundle('a', 'completed');
    const snapshot: DatabaseSnapshot = { dataVersion: 1, opponents: [item.opponent], matches: [item.match], sets: item.sets, games: item.games, tieBreaks: item.tieBreaks, voiceDrafts: [{ ...stamp, id: 'd', matchId: 'a', transcript: '', dataVersion: 1 }] };
    switch (broken) {
      case 'opponent': snapshot.matches[0].opponentId = 'missing'; break;
      case 'set parent': snapshot.sets[0].matchId = 'missing'; break;
      case 'game parent': snapshot.games[0].setId = 'missing'; break;
      case 'tie-break parent': snapshot.tieBreaks[0].setId = 'missing'; break;
      case 'tie-break link': snapshot.sets[1].tieBreakId = null; break;
      case 'missing tie-break': snapshot.tieBreaks = []; break;
      case 'draft parent': snapshot.voiceDrafts[0].matchId = 'missing'; break;
    }
    await expect(repo.replaceAll(snapshot)).rejects.toThrow();
    expect((await repo.getActiveMatch())?.match.id).toBe('original');
    expect(await repo.listOpponents()).toEqual([bundle('original').opponent]);
  });
  it('accepts a structurally connected replacement including a draft', async () => {
    const repo = await setup(); const item = bundle('a');
    const draft = { ...stamp, id: 'd', matchId: 'a', transcript: '', dataVersion: 1 };
    await repo.replaceAll({ dataVersion: 1, opponents: [item.opponent], matches: [item.match], sets: item.sets, games: item.games, tieBreaks: item.tieBreaks, voiceDrafts: [draft] });
    expect((await repo.getActiveMatch())?.match.id).toBe('a');
    expect(await repo.getDraft('d')).toEqual(draft);
  });
  it('rolls back a bundle when a child key conflicts after writes have started', async () => {
    const repo = await setup();
    const first = bundle('a', 'completed');
    await repo.saveMatchBundle(first);
    const second = bundle('b', 'completed');
    second.games[0].id = first.games[0].id;
    await expect(repo.saveMatchBundle(second)).rejects.toThrow();
    expect(await repo.getMatchBundle('b')).toBeUndefined();
    expect(await repo.getMatchBundle('a')).toEqual({ ...first, sets: [...first.sets].reverse(), games: [...first.games].reverse() });
  });
  it('rolls back replacement if inserting records fails after clearing', async () => {
    const repo = await setup(); await repo.saveMatchBundle(bundle('original'));
    const item = bundle('a', 'completed');
    const snapshot: DatabaseSnapshot = { dataVersion: 1, opponents: [item.opponent, item.opponent], matches: [item.match], sets: item.sets, games: item.games, tieBreaks: item.tieBreaks, voiceDrafts: [] };
    await expect(repo.replaceAll(snapshot)).rejects.toThrow();
    expect((await repo.getActiveMatch())?.match.id).toBe('original');
  });
});
