// @vitest-environment node
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import type { MatchBundle, DatabaseSnapshot, VoiceDraft, MatchDiagnostic } from '../../domain/model';
import { openDatabase } from './database';
import { TennisDatabase } from './schema';
import { IndexedDbTennisRepository } from './repositories';
import { DATA_VERSION } from './migrations';
import { ReadOnlyRecoveryError } from '../../application/recovery';

const stamp = { createdAt: '2026-01-01', updatedAt: '2026-01-01' };
const bundle = (id: string, status: 'active' | 'completed' = 'active'): MatchBundle => ({
  opponent: { ...stamp, id: 'o', name: 'Alex', normalizedName: 'alex' },
  match: { ...stamp, id, opponentId: 'o', playedAt: stamp.createdAt, format: 'oneSet', firstServer: 'player', status, comments: null },
  sets: [{ ...stamp, id: `${id}-s2`, matchId: id, ordinal: 2, kind: 'standard', status: 'active', tieBreakId: null }, { ...stamp, id: `${id}-s1`, matchId: id, ordinal: 1, kind: 'standard', status: 'completed', tieBreakId: `${id}-t` }],
  games: [2, 1].map(ordinal => ({ ...stamp, id: `${id}-g${ordinal}`, setId: `${id}-s1`, ordinal, server: 'player', result: 'won', score: null, netErrors: 0, wideErrors: null, longErrors: null, doubleFaults: null, failedReturns: null, unforcedErrors: null, comments: null })),
  tieBreaks: [{ ...stamp, id: `${id}-t`, setId: `${id}-s1`, kind: 'standard', playerPoints: 7, opponentPoints: 0, netErrors: null, wideErrors: 0, longErrors: null, doubleFaults: null }],
});
const draftFixture = (matchId: string): VoiceDraft => ({ ...stamp, id: 'd', matchId, setId: `${matchId}-s2`, confirmationId: 'c', dataVersion: 2, recording: null, mimeType: null, transcripts: [], parsedDraft: null, state: 'recorded', error: null });
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
  it.each([
    ['an added game', (b: MatchBundle) => ({ ...b, games: [...b.games, { ...b.games[0], id: 'manual', ordinal: 3 }] })],
    ['an edited match comment', (b: MatchBundle) => ({ ...b, match: { ...b.match, comments: 'manual edit' } })],
    ['a metric changed from 0 to unknown', (b: MatchBundle) => ({ ...b, games: b.games.map(g => g.ordinal === 1 ? { ...g, netErrors: null } : g) })],
    ['a removed tie-break metric', (b: MatchBundle) => ({ ...b, tieBreaks: b.tieBreaks.map(t => ({ ...t, wideErrors: null })) })],
  ])('rejects confirmation against a stale base after %s, keeping the edit and the draft', async (_label, edit) => {
    const repo = await setup(); const base = bundle('m'); await repo.saveMatchBundle(base); await repo.saveDraft(draftFixture('m'));
    const edited = edit((await repo.getMatchBundle('m'))!); await repo.saveMatchBundle(edited);
    const prepared = { ...base, games: [...base.games, { ...base.games[0], id: 'voice', setId: 'm-s2', ordinal: 1 }] };
    await expect(repo.confirmDraft('d', 'c', prepared, 'now', base)).rejects.toThrow(/changed/i);
    expect((await repo.getMatchBundle('m'))?.games.map(g => g.id).sort()).toEqual(edited.games.map(g => g.id).sort());
    expect((await repo.getMatchBundle('m'))?.match.comments).toBe(edited.match.comments);
    expect(await repo.getDraft('d')).toEqual(draftFixture('m')); expect(await repo.getDraftConfirmation('d')).toBeUndefined();
  });
  it('accepts an unchanged base regardless of entity order or key order', async () => {
    const repo = await setup(); const base = bundle('m'); await repo.saveMatchBundle(base); await repo.saveDraft(draftFixture('m'));
    const stored = (await repo.getMatchBundle('m'))!;
    const reordered: MatchBundle = { tieBreaks: [...stored.tieBreaks], games: [...stored.games].reverse(), sets: [...stored.sets].reverse(), opponent: { ...stored.opponent }, match: Object.fromEntries(Object.entries(stored.match).reverse()) as MatchBundle['match'] };
    const prepared = { ...stored, games: [...stored.games, { ...stored.games[0], id: 'voice', setId: 'm-s2', ordinal: 1 }] };
    expect(await repo.confirmDraft('d', 'c', prepared, 'now', reordered)).toEqual({ status: 'confirmed' });
  });
  it('does not recreate a draft when its save is queued behind confirmation', async () => {
    const repo = await setup(); const initial = bundle('m'); const draft = draftFixture('m');
    await repo.saveMatchBundle(initial); await repo.saveDraft(draft);
    const confirming = repo.confirmDraft('d', 'c', initial, 'now', bundle('m'));
    const saving = repo.saveDraft(draft);
    await confirming;
    await expect(saving).rejects.toThrow();
    expect(await repo.getDraft('d')).toBeUndefined();
  });
  it('refuses draft saves with malformed or duplicate confirmation markers', async () => {
    const name = `guard-invalid-${crypto.randomUUID()}`;
    const db = new TennisDatabase(name); await db.open();
    const repo = new IndexedDbTennisRepository(db, null);
    cleanup.push(async () => { repo.close(); await indexedDBDelete(name); });
    await repo.saveMatchBundle(bundle('m'));
    await db.metadata.put({ key: 'draft-confirmation:c', value: 1 });
    await expect(repo.saveDraft(draftFixture('m'))).rejects.toThrow();
    await db.metadata.put({ key: 'draft-confirmation:c', value: { draftId: 'd', matchId: 'm', confirmedAt: 'now' } });
    await db.metadata.put({ key: 'draft-confirmation:x', value: { draftId: 'd', matchId: 'm', confirmedAt: 'now' } });
    await expect(repo.saveDraft(draftFixture('m'))).rejects.toThrow();
    expect(await repo.getDraft('d')).toBeUndefined();
  });
  it('allows durable confirmation lookup in recovery mode', async () => {
    const name = `lookup-recovery-${crypto.randomUUID()}`;
    const db = new TennisDatabase(name); await db.open();
    const repo = new IndexedDbTennisRepository(db, new Error('recovery'));
    cleanup.push(async () => { repo.close(); await indexedDBDelete(name); });
    await db.metadata.put({ key: 'draft-confirmation:c', value: { draftId: 'd', matchId: 'm', confirmedAt: 'now' } });
    expect(await repo.getDraftConfirmation('d')).toEqual({ confirmationId: 'c', matchId: 'm', confirmedAt: 'now' });
  });
  it('round trips rich draft content without changing nulls, zeroes or audio', async () => {
    const repo = await setup(); await repo.saveMatchBundle(bundle('m'));
    const draft: VoiceDraft = { ...draftFixture('m'), recording: new Blob(['audio'], { type: 'audio/mp4' }), mimeType: 'audio/mp4', transcripts: [{ text: 'first', provider: 'openai', model: 'test', timestamp: 'now' }, { text: 'second', provider: 'openai', model: 'test', timestamp: 'later' }], parsedDraft: { version: 2, warnings: ['warning'], games: [{ server: 'player', result: 'won', netErrors: 0, wideErrors: null, longErrors: null, doubleFaults: 0, failedReturns: null, unforcedErrors: null, comments: null }] }, state: 'waiting-retry', error: { code: 'network', message: 'retry', phase: 'parser' } };
    await repo.saveDraft(draft);
    const saved = await repo.getDraft('d');
    expect(saved).toEqual(draft);
    expect(await saved?.recording?.text()).toBe('audio');
    await repo.saveMatchBundle(bundle('m'));
    expect(await repo.getDraft('d')).toEqual(draft);
  });
  it('rolls back bundle writes and marker on failure before draft deletion', async () => {
    const name = `rollback-${crypto.randomUUID()}`;
    const db = new TennisDatabase(name); await db.open();
    const repo = new IndexedDbTennisRepository(db, null, () => { throw new Error('injected'); });
    cleanup.push(async () => { repo.close(); await indexedDBDelete(name); });
    const initial = bundle('m'); await repo.saveMatchBundle(initial);
    const draft = { ...draftFixture('m'), recording: new Blob(['audio']) }; await repo.saveDraft(draft);
    const before = await repo.getMatchBundle('m');
    await expect(repo.confirmDraft('d', 'c', { ...initial, games: [] }, 'now', bundle('m'))).rejects.toThrow('injected');
    expect(await repo.getMatchBundle('m')).toEqual(before);
    expect(await repo.getDraft('d')).toEqual(draft);
    expect(await (await repo.getDraft('d'))?.recording?.text()).toBe('audio');
    expect(await db.metadata.get('draft-confirmation:c')).toBeUndefined();
  });
  it('serializes confirmation across separate repository instances', async () => {
    const name = `race-${crypto.randomUUID()}`;
    const a = await openDatabase(name); const b = await openDatabase(name);
    cleanup.push(async () => { a.close(); b.close(); await indexedDBDelete(name); });
    const initial = bundle('m'); await a.saveMatchBundle(initial); await a.saveDraft(draftFixture('m'));
    const results = await Promise.all([a.confirmDraft('d', 'c', initial, 'now', bundle('m')), b.confirmDraft('d', 'c', initial, 'now', bundle('m'))]);
    expect(results.map(r => r.status).sort()).toEqual(['alreadyConfirmed', 'confirmed']);
    expect((await a.getMatchBundle('m'))?.games).toHaveLength(2);
  });
  it('rejects wrong bindings, missing drafts, invalid relationships and marker collisions', async () => {
    const repo = await setup(); const initial = bundle('m'); await repo.saveMatchBundle(initial); await repo.saveDraft(draftFixture('m'));
    await expect(repo.confirmDraft('missing', 'c', initial, 'now', bundle('m'))).rejects.toThrow();
    await expect(repo.confirmDraft('d', 'wrong', initial, 'now', bundle('m'))).rejects.toThrow();
    await expect(repo.confirmDraft('d', 'c', bundle('other'), 'now', bundle('m'))).rejects.toThrow();
    await expect(repo.confirmDraft('d', 'c', { ...initial, games: [{ ...initial.games[0], setId: 'missing' }] }, 'now', bundle('m'))).rejects.toThrow();
    expect(await repo.getDraft('d')).toBeDefined();
    await repo.confirmDraft('d', 'c', initial, 'now', bundle('m'));
    await repo.saveMatchBundle(initial);
    expect(await repo.confirmDraft('d', 'c', initial, 'later', bundle('m'))).toEqual({ status: 'alreadyConfirmed' });
    await expect(repo.confirmDraft('d', 'other', initial, 'now', bundle('m'))).rejects.toThrow();
    await expect(repo.confirmDraft('other', 'c', initial, 'now', bundle('m'))).rejects.toThrow(/marker/i);
    await expect(repo.confirmDraft('d', 'c', bundle('other'), 'now', bundle('m'))).rejects.toThrow(/marker/i);
  });
  it('rejects a malformed marker instead of treating it as a confirmed retry', async () => {
    const name = `malformed-${crypto.randomUUID()}`;
    const repo = await openDatabase(name);
    const db = new TennisDatabase(name); await db.open();
    cleanup.push(async () => { db.close(); repo.close(); await indexedDBDelete(name); });
    await db.metadata.put({ key: 'draft-confirmation:c', value: { draftId: 'd', matchId: 'm', confirmedAt: '' } });
    await expect(repo.confirmDraft('d', 'c', bundle('m'), 'now', bundle('m'))).rejects.toThrow(/marker/i);
  });
  it('looks up a durable confirmation by draft after reopening', async () => {
    const name = `lookup-${crypto.randomUUID()}`;
    const repo = await openDatabase(name);
    cleanup.push(async () => { repo.close(); await indexedDBDelete(name); });
    await repo.saveMatchBundle(bundle('m')); await repo.saveDraft(draftFixture('m'));
    expect(await repo.getDraftConfirmation('d')).toBeUndefined();
    await repo.confirmDraft('d', 'c', bundle('m'), 'now', bundle('m'));
    repo.close();
    const reopened = await openDatabase(name);
    try { expect(await reopened.getDraftConfirmation('d')).toEqual({ confirmationId: 'c', matchId: 'm', confirmedAt: 'now' }); }
    finally { reopened.close(); }
  });
  it('rejects malformed and colliding confirmation rows during lookup', async () => {
    const name = `lookup-invalid-${crypto.randomUUID()}`;
    const repo = await openDatabase(name); const db = new TennisDatabase(name); await db.open();
    cleanup.push(async () => { db.close(); repo.close(); await indexedDBDelete(name); });
    await db.metadata.put({ key: 'draft-confirmation:c', value: { draftId: 'd', matchId: 'm', confirmedAt: '' } });
    await expect(repo.getDraftConfirmation('d')).rejects.toThrow(/marker/i);
    await db.metadata.put({ key: 'draft-confirmation:c', value: { draftId: 'd', matchId: 'm', confirmedAt: 'now' } });
    await db.metadata.put({ key: 'draft-confirmation:other', value: { draftId: 'd', matchId: 'm', confirmedAt: 'now' } });
    await expect(repo.getDraftConfirmation('d')).rejects.toThrow(/marker/i);
  });
  it('rejects an empty confirmation timestamp without writing the bundle', async () => {
    const repo = await setup(); const initial = bundle('m');
    await repo.saveMatchBundle(initial); await repo.saveDraft(draftFixture('m'));
    await expect(repo.confirmDraft('d', 'c', { ...initial, games: [] }, '', bundle('m'))).rejects.toThrow();
    expect(await repo.getDraft('d')).toBeDefined();
    expect((await repo.getMatchBundle('m'))?.games).toHaveLength(2);
  });
  it('confirms a draft once and remembers the confirmation after reopening', async () => {
    const name = `confirmation-${crypto.randomUUID()}`;
    const repo = await openDatabase(name);
    cleanup.push(async () => { repo.close(); await indexedDBDelete(name); });
    const initial = bundle('m');
    await repo.saveMatchBundle(initial);
    const draft = { ...stamp, id: 'd', matchId: 'm', setId: 'm-s2', confirmationId: 'c', dataVersion: 2 as const, recording: new Blob(['audio'], { type: 'audio/mp4' }), mimeType: 'audio/mp4', transcripts: [{ text: 'hello', provider: 'openai', model: 'test', timestamp: stamp.createdAt }], parsedDraft: { version: 2 as const, games: [], warnings: [] }, state: 'ready' as const, error: null };
    await repo.saveDraft(draft);
    expect(await repo.getDraft('d')).toEqual(draft);
    const prepared = { ...initial, games: [...initial.games, { ...initial.games[0], id: 'new-game', setId: 'm-s2' }] };
    expect(await repo.confirmDraft('d', 'c', prepared, 'now', bundle('m'))).toEqual({ status: 'confirmed' });
    expect(await repo.getDraft('d')).toBeUndefined();
    repo.close();
    const reopened = await openDatabase(name);
    try {
      expect(await reopened.confirmDraft('d', 'c', prepared, 'later', bundle('m'))).toEqual({ status: 'alreadyConfirmed' });
      expect((await reopened.getMatchBundle('m'))?.games).toHaveLength(3);
    } finally { reopened.close(); }
  });
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
  it('lists matches newest first and filters by opponent and inclusive instant range', async () => {
    const repo = await setup();
    const at = (id: string, playedAt: string, opponentId = 'o') => { const b = bundle(id, 'completed'); return { ...b, opponent: { ...b.opponent, id: opponentId, name: opponentId, normalizedName: opponentId }, match: { ...b.match, opponentId, playedAt } }; };
    await repo.saveMatchBundle(at('old', '2026-01-01T10:00:00.000Z'));
    await repo.saveMatchBundle(at('new', '2026-03-01T10:00:00.000Z', 'p'));
    await repo.saveMatchBundle(at('mid', '2026-02-01T10:00:00.000Z'));
    const ids = async (filter?: Parameters<typeof repo.listMatches>[0]) => (await repo.listMatches(filter)).map(m => m.id);
    expect(await ids()).toEqual(['new', 'mid', 'old']);
    expect(await ids({ opponentId: 'o' })).toEqual(['mid', 'old']);
    expect(await ids({ from: '2026-02-01T10:00:00.000Z' })).toEqual(['new', 'mid']);
    expect(await ids({ to: '2026-02-01T10:00:00.000Z' })).toEqual(['mid', 'old']);
    expect(await ids({ opponentId: 'o', from: '2026-01-15T00:00:00.000Z', to: '2026-02-28T00:00:00.000Z' })).toEqual(['mid']);
  });
  it('abandons only an active match without replacing its children', async () => {
    const repo = await setup(); const original = bundle('m');
    await repo.saveMatchBundle(original);
    await repo.abandonMatch('m', '2026-03-01');
    const saved = await repo.getMatchBundle('m');
    expect(saved?.match).toMatchObject({ status: 'abandoned', updatedAt: '2026-03-01' });
    expect(saved?.sets).toHaveLength(2);
    expect(saved?.games).toHaveLength(2);
    expect(saved?.tieBreaks).toHaveLength(1);
    await expect(repo.abandonMatch('m', '2026-03-02')).rejects.toThrow(/not active/i);
    expect((await repo.getMatchBundle('m'))?.match.updatedAt).toBe('2026-03-01');
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
    await repo.saveDraft({ ...draftFixture('m'), recording });
    const draft = await repo.getDraft('d');
    expect(await draft?.recording?.text()).toBe('audio');
    expect(draft?.recording?.type).toBe('audio/webm');
    await repo.deleteDraft('d'); expect(await repo.getDraft('d')).toBeUndefined();
  });
  it('rejects drafts without a parent, including saves queued after deletion', async () => {
    const repo = await setup();
    const draft = draftFixture('m');
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
    const snapshot: DatabaseSnapshot = { dataVersion: DATA_VERSION, opponents: [a.opponent], matches: [a.match, b.match], sets: [], games: [], tieBreaks: [], voiceDrafts: [] };
    await expect(repo.replaceAll(snapshot)).rejects.toThrow();
    expect((await repo.getActiveMatch())?.match.id).toBe('original');
  });
  it.each(['opponent', 'set parent', 'game parent', 'tie-break parent', 'tie-break link', 'missing tie-break', 'draft parent'])('rejects a replacement with broken %s integrity', async broken => {
    const repo = await setup(); await repo.saveMatchBundle(bundle('original'));
    const item = bundle('a', 'completed');
    const snapshot: DatabaseSnapshot = { dataVersion: DATA_VERSION, opponents: [item.opponent], matches: [item.match], sets: item.sets, games: item.games, tieBreaks: item.tieBreaks, voiceDrafts: [draftFixture('a')] };
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
    const draft = draftFixture('a');
    await repo.replaceAll({ dataVersion: DATA_VERSION, opponents: [item.opponent], matches: [item.match], sets: item.sets, games: item.games, tieBreaks: item.tieBreaks, voiceDrafts: [draft] });
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
    const snapshot: DatabaseSnapshot = { dataVersion: DATA_VERSION, opponents: [item.opponent, item.opponent], matches: [item.match], sets: item.sets, games: item.games, tieBreaks: item.tieBreaks, voiceDrafts: [] };
    await expect(repo.replaceAll(snapshot)).rejects.toThrow();
    expect((await repo.getActiveMatch())?.match.id).toBe('original');
  });
});

describe('IndexedDB repository backup support', () => {
  const records = (item: MatchBundle) => ({ opponents: [item.opponent], matches: [item.match], sets: item.sets, games: item.games, tieBreaks: item.tieBreaks });
  it('reads every table in one snapshot at the current data version', async () => {
    const repo = await setup(); const item = bundle('a'); await repo.saveMatchBundle(item); await repo.saveDraft(draftFixture('a'));
    const snapshot = await repo.snapshot();
    expect(snapshot.dataVersion).toBe(DATA_VERSION);
    expect(snapshot.opponents).toEqual([item.opponent]); expect(snapshot.matches).toEqual([item.match]);
    expect(snapshot.sets).toHaveLength(2); expect(snapshot.games).toHaveLength(2); expect(snapshot.tieBreaks).toHaveLength(1);
    expect(snapshot.voiceDrafts).toEqual([draftFixture('a')]);
  });
  it('inserts new records, including matches for an existing opponent, in one transaction', async () => {
    const repo = await setup(); await repo.saveMatchBundle(bundle('original', 'completed'));
    const item = bundle('a', 'completed');
    await repo.insertRecords({ ...records(item), opponents: [] });
    expect((await repo.getMatchBundle('a'))?.games).toHaveLength(2);
    expect(await repo.listOpponents()).toHaveLength(1);
  });
  it('rolls back every insert when a record id already exists, never overwriting it', async () => {
    const repo = await setup(); const original = bundle('original', 'completed'); await repo.saveMatchBundle(original);
    const item = bundle('a', 'completed');
    const newOpponent = { ...stamp, id: 'new-o', name: 'Sam', normalizedName: 'sam' };
    const tampered = { ...records(item), opponents: [newOpponent], games: [...item.games, { ...item.games[0], id: original.games[0].id, ordinal: 9 }] };
    await expect(repo.insertRecords(tampered)).rejects.toThrow();
    expect(await repo.getMatchBundle('a')).toBeUndefined();
    expect(await repo.listOpponents()).toEqual([original.opponent]);
    expect((await repo.getMatchBundle('original'))?.games.map(g => g.ordinal).sort()).toEqual([1, 2]);
  });
  it.each([
    ['a second active match', () => ({ ...records(bundle('b')), opponents: [] })],
    ['a missing opponent', () => { const r = records(bundle('b', 'completed')); return { ...r, opponents: [], matches: [{ ...r.matches[0], opponentId: 'missing' }] }; }],
    ['children for an existing match', () => { const r = records(bundle('original')); return { opponents: [], matches: [], sets: [{ ...r.sets[0], id: 'extra-set', tieBreakId: null }], games: [], tieBreaks: [] }; }],
    ['a broken tie-break link', () => { const r = records(bundle('b', 'completed')); return { ...r, opponents: [], tieBreaks: [] }; }],
    ['an orphan game', () => { const r = records(bundle('b', 'completed')); return { ...r, opponents: [], games: [{ ...r.games[0], setId: 'missing' }] }; }],
  ])('rejects inserting %s without writing anything', async (_label, make) => {
    const repo = await setup(); await repo.saveMatchBundle(bundle('original'));
    const before = await repo.snapshot();
    await expect(repo.insertRecords(make())).rejects.toThrow();
    expect(await repo.snapshot()).toEqual(before);
  });
  it('snapshots a never-migrated (data version 0, no version row) database in recovery mode, so it can still be exported', async () => {
    const name = `snapshot-recovery-${crypto.randomUUID()}`;
    const db = new TennisDatabase(name); await db.open();
    const item = bundle('a', 'completed');
    await db.opponents.put(item.opponent); await db.matches.put(item.match); await db.sets.bulkPut(item.sets); await db.games.bulkPut(item.games); await db.tieBreaks.bulkPut(item.tieBreaks);
    const repo = new IndexedDbTennisRepository(db, new Error('migration failed'));
    cleanup.push(async () => { repo.close(); await indexedDBDelete(name); });
    const snapshot = await repo.snapshot();
    expect(snapshot.dataVersion).toBe(0);
    expect(snapshot.matches).toEqual([item.match]); expect(snapshot.games).toHaveLength(2);
    expect(await db.metadata.get('dataVersion'), 'reading never writes a version row').toBeUndefined();
  });
  it('snapshots data without changing an unreadable version row in invalid-data-version recovery', async () => {
    const name = `snapshot-invalid-${crypto.randomUUID()}`;
    const db = new TennisDatabase(name); await db.open();
    const item = bundle('a', 'completed');
    await db.opponents.put(item.opponent); await db.matches.put(item.match); await db.sets.bulkPut(item.sets); await db.games.bulkPut(item.games); await db.tieBreaks.bulkPut(item.tieBreaks);
    await db.metadata.put({ key: 'dataVersion', value: 'two' as never });
    const repo = new IndexedDbTennisRepository(db, new Error('recovery'));
    cleanup.push(async () => { repo.close(); await indexedDBDelete(name); });
    const snapshot = await repo.snapshot();
    expect(snapshot.dataVersion).toBe(0);
    expect(snapshot.matches).toEqual([item.match]); expect(snapshot.games).toHaveLength(2);
    expect((await db.metadata.get('dataVersion'))?.value).toBe('two');
  });
  it('refuses inserts in read-only recovery mode', async () => {
    const name = `insert-recovery-${crypto.randomUUID()}`;
    const db = new TennisDatabase(name); await db.open();
    const repo = new IndexedDbTennisRepository(db, new Error('recovery'));
    cleanup.push(async () => { repo.close(); await indexedDBDelete(name); });
    await expect(repo.insertRecords(records(bundle('a', 'completed')))).rejects.toThrow(/read.only/i);
  });
});

const diag = (id: string, matchId: string, startedAt: string, outcome: MatchDiagnostic['outcome'] = 'success'): MatchDiagnostic => ({ id, matchId, setId: null, draftId: null, phase: 'parser', attempt: 1, provider: 'p', model: 'm', startedAt, finishedAt: startedAt, outcome, transcript: null, request: null, response: null, error: null });
describe('diagnostics storage', () => {
  it('lists per match sorted by startedAt and counts', async () => {
    const repo = await setup();
    await repo.saveDiagnostic(diag('a2', 'A', '2026-01-02')); await repo.saveDiagnostic(diag('a1', 'A', '2026-01-01')); await repo.saveDiagnostic(diag('b1', 'B', '2026-01-01'));
    expect((await repo.listDiagnostics('A')).map(r => r.id)).toEqual(['a1', 'a2']);
    expect(await repo.countDiagnostics('A')).toBe(2); expect(await repo.countDiagnostics('B')).toBe(1);
  });
  it('deleteMatch removes only that match diagnostics', async () => {
    const repo = await setup(); await repo.saveMatchBundle(bundle('A', 'completed'));
    await repo.saveDiagnostic(diag('a1', 'A', '1')); await repo.saveDiagnostic(diag('b1', 'B', '1'));
    await repo.deleteMatch('A');
    expect(await repo.listDiagnostics('A')).toEqual([]); expect(await repo.listDiagnostics('B')).toHaveLength(1);
  });
  it('keeps rows across draft confirmation and deletion', async () => {
    const repo = await setup(); const initial = bundle('A'); await repo.saveMatchBundle(initial); await repo.saveDraft(draftFixture('A'));
    await repo.saveDiagnostic(diag('a1', 'A', '1'));
    await repo.confirmDraft('d', 'c', initial, 'now', bundle('A'));
    expect(await repo.countDiagnostics('A')).toBe(1);
    await repo.saveDraft({ ...draftFixture('A'), id: 'd2', confirmationId: 'c2' }); await repo.deleteDraft('d2');
    expect(await repo.countDiagnostics('A')).toBe(1);
  });
  it('replaceAll clears diagnostics and snapshot omits them', async () => {
    const repo = await setup(); const item = bundle('a', 'completed');
    await repo.saveDiagnostic(diag('a1', 'a', '1'));
    expect(await repo.snapshot()).not.toHaveProperty('diagnostics');
    await repo.replaceAll({ dataVersion: DATA_VERSION, opponents: [item.opponent], matches: [item.match], sets: item.sets, games: item.games, tieBreaks: item.tieBreaks, voiceDrafts: [] });
    expect(await repo.countDiagnostics('a')).toBe(0);
    expect(await repo.snapshot()).not.toHaveProperty('diagnostics');
  });
  it('prunes to 500 per match, dropping successes first, then the oldest', async () => {
    const repo = await setup(); const t = (i: number) => `2026-01-01T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`;
    for (let i = 0; i < 505; i++) await repo.saveDiagnostic(diag(`r${i}`, 'A', t(i), i < 5 ? 'success' : 'error'));
    const rows = await repo.listDiagnostics('A');
    expect(rows).toHaveLength(500); expect(rows.some(r => r.outcome === 'success')).toBe(false);
    const repo2 = await setup();
    for (let i = 0; i < 501; i++) await repo2.saveDiagnostic(diag(`r${i}`, 'A', t(i), 'error'));
    const rows2 = await repo2.listDiagnostics('A');
    expect(rows2).toHaveLength(500); expect(rows2[0].id).toBe('r1');
  }, 60000);
  it('refuses saves in read-only recovery but still lists', async () => {
    const name = `diag-recovery-${crypto.randomUUID()}`;
    const db = new TennisDatabase(name); await db.open();
    const repo = new IndexedDbTennisRepository(db, new Error('recovery'));
    cleanup.push(async () => { repo.close(); await indexedDBDelete(name); });
    await expect(repo.saveDiagnostic(diag('x', 'A', '1'))).rejects.toBeInstanceOf(ReadOnlyRecoveryError);
    expect(await repo.listDiagnostics('A')).toEqual([]);
  });
});
