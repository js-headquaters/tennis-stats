// @vitest-environment node
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../infrastructure/db/database';
import { TennisDatabase } from '../infrastructure/db/schema';
import type { MatchBundle, VoiceDraft } from '../domain/model';
import { applyImport, backupFileName, clearAllData, exportBackup, previewImport, previewMerge, serializeBackup, type ImportPreview } from './backupService';

const fixture = (name: string) => readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url), 'utf8');
const v1Text = fixture('backup-v1.json');
const v0Text = fixture('backup-v0.json');
const v1 = JSON.parse(v1Text);
const clock = { now: () => '2026-11-12T08:30:00.000Z' };
const fixtureClock = { now: () => v1.exportedAt as string };

const repos: Awaited<ReturnType<typeof openDatabase>>[] = [];
afterEach(() => { repos.forEach(repo => repo.close()); repos.length = 0; });
async function setup() { const repo = await openDatabase(`backup-${crypto.randomUUID()}`); repos.push(repo); return repo; }
function ok(preview: ImportPreview) { if (!preview.ok) throw new Error(`expected ok preview: ${preview.error}`); return preview; }
function error(preview: ImportPreview) { if (preview.ok) throw new Error('expected failed preview'); return preview.error; }
async function seeded() { const repo = await setup(); await applyImport(ok(previewImport(v1Text)), 'replace', repo); return repo; }

const stamp = { createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' };
const ownBundle = (id: string, status: 'active' | 'completed', opponent = { ...stamp, id: 'mine-alex', name: 'ALEX', normalizedName: 'alex' }): MatchBundle => ({
  opponent,
  match: { ...stamp, id, opponentId: opponent.id, playedAt: '2026-10-01T09:00:00.000Z', format: 'oneSet', firstServer: 'player', status, comments: null },
  sets: [{ ...stamp, id: `${id}-s1`, matchId: id, ordinal: 1, kind: 'standard', status: status === 'active' ? 'active' : 'completed', tieBreakId: null }],
  games: [{ ...stamp, id: `${id}-g1`, setId: `${id}-s1`, ordinal: 1, server: 'player', result: 'won', score: null, netErrors: 0, wideErrors: null, longErrors: null, doubleFaults: null, failedReturns: null }],
  tieBreaks: [],
});
const draft = (id: string, matchId: string, setId: string): VoiceDraft => ({ ...stamp, id, matchId, setId, confirmationId: `c-${id}`, dataVersion: 1, recording: new Blob(['secret audio'], { type: 'audio/mp4' }), mimeType: 'audio/mp4', transcripts: [{ text: 'won the game', provider: 'openai', model: 'm', timestamp: 't' }], parsedDraft: null, state: 'ready', error: null });

describe('exportBackup', () => {
  it('produces deterministic, versioned JSON regardless of storage order', async () => {
    const repo = await setup();
    await repo.saveMatchBundle(ownBundle('b-match', 'completed'));
    await repo.saveMatchBundle({ ...ownBundle('a-match', 'active'), games: [...ownBundle('a-match', 'active').games].reverse() });
    const first = serializeBackup(await exportBackup(repo, clock));
    const second = serializeBackup(await exportBackup(repo, clock));
    expect(first).toBe(second);
    const parsed = JSON.parse(first);
    expect(Object.keys(parsed)).toEqual(['format', 'version', 'exportedAt', 'data']);
    expect(parsed).toMatchObject({ format: 'tennis-stats-backup', version: 1, exportedAt: clock.now() });
    expect(Object.keys(parsed.data)).toEqual(['opponents', 'matches', 'sets', 'games', 'tieBreaks']);
    expect(Object.keys(parsed.data.games[0])).toEqual(['id', 'setId', 'ordinal', 'server', 'result', 'score', 'netErrors', 'wideErrors', 'longErrors', 'doubleFaults', 'failedReturns', 'createdAt', 'updatedAt']);
    expect(first.endsWith('\n')).toBe(true);
  });
  it('re-exports an imported fixture byte-for-byte, preserving null, 0, empty strings and comments', async () => {
    const repo = await seeded();
    expect(serializeBackup(await exportBackup(repo, fixtureClock))).toBe(v1Text);
    const legacy = await setup();
    await applyImport(ok(previewImport(v0Text)), 'replace', legacy);
    const exported = await exportBackup(legacy, clock);
    expect(exported.data.matches[0].comments).toBe('');
    expect(exported.data.games[0]).toMatchObject({ netErrors: 0, wideErrors: 0, longErrors: 0, doubleFaults: 0, failedReturns: null, score: null });
  });
  it('excludes secrets, drafts, pending audio, settings and service-worker state', async () => {
    const repo = await seeded();
    await repo.saveDraft(draft('d1', 'match-2', 'set-2'));
    const text = serializeBackup(await exportBackup(repo, clock));
    for (const forbidden of ['apiKey', 'sk-', 'endpoint', 'draft', 'recording', 'transcript', 'secret audio', 'audio/mp4', 'serviceWorker', 'provider', 'dataVersion']) expect(text).not.toContain(forbidden);
    expect(text).toContain('Windy; served well');
  });
  it('exports tennis records while an unreadable data version keeps the repository in read-only recovery', async () => {
    const name = `backup-invalid-version-${crypto.randomUUID()}`;
    const db = new TennisDatabase(name); await db.open();
    const item = ownBundle('recoverable', 'completed');
    await db.opponents.put(item.opponent); await db.matches.put(item.match); await db.sets.bulkPut(item.sets); await db.games.bulkPut(item.games);
    await db.metadata.put({ key: 'dataVersion', value: 'not-a-number' as never });
    db.close();
    const repo = await openDatabase(name); repos.push(repo);
    expect(repo.getRecoveryStatus()).toMatchObject({ mode: 'readOnly', diagnostics: { code: 'invalid-data-version' } });
    const exported = await exportBackup(repo, clock);
    expect(exported.data.matches.map(match => match.id)).toEqual(['recoverable']);
    expect(exported.data.games.map(game => game.id)).toEqual(['recoverable-g1']);
  });
  it('names files from the injected clock date', () => {
    expect(backupFileName(clock.now())).toBe('tennis-stats-backup-v1-2026-11-12.json');
    expect(() => backupFileName('not a date')).toThrow();
  });
});

describe('previewImport', () => {
  it('validates a version-1 file and reports accepted counts', () => {
    const preview = ok(previewImport(v1Text));
    expect(preview).toMatchObject({ sourceVersion: 1, exportedAt: v1.exportedAt, rejected: [], remaps: [], warnings: [] });
    expect(preview.counts).toEqual({ opponents: { total: 2, accepted: 2, rejected: 0 }, matches: { total: 2, accepted: 2, rejected: 0 }, sets: { total: 2, accepted: 2, rejected: 0 }, games: { total: 3, accepted: 3, rejected: 0 }, tieBreaks: { total: 1, accepted: 1, rejected: 0 } });
    expect(preview.records).toEqual(v1.data);
  });
  it('migrates a legacy version-0 table dump in memory and reports excluded drafts', () => {
    const before = v0Text;
    const preview = ok(previewImport(v0Text));
    expect(v0Text).toBe(before);
    expect(preview.sourceVersion).toBe(0);
    expect(preview.exportedAt).toBeNull();
    expect(preview.records.matches.map(m => m.id)).toEqual(['legacy-match-1']);
    expect(preview.records.games[0]).toMatchObject({ netErrors: 0, failedReturns: null });
    expect(preview.warnings).toEqual([expect.stringMatching(/1 voice draft.*not imported/i)]);
  });
  it.each([
    ['garbage', 'not json at all {', /not valid JSON/i],
    ['an empty file', '', /not valid JSON/i],
    ['a JSON array', '[]', /not a Tennis Stats backup/i],
    ['another app file', '{"hello":"world"}', /not a Tennis Stats backup/i],
    ['an unknown future version', JSON.stringify({ ...v1, version: 7 }), /version 7.*versions 0 and 1/i],
    ['a non-numeric version', JSON.stringify({ ...v1, version: 'x' }), /unsupported backup version/i],
    ['an unknown legacy version', JSON.stringify({ dataVersion: 5, opponents: [] }), /unsupported backup version/i],
    ['unknown top-level keys', JSON.stringify({ ...v1, settings: { apiKey: 'sk-live-123' } }), /unrecognized/i],
    ['a prototype pollution key', v1Text.replace('"format"', '"__proto__": {"polluted": true}, "format"'), /forbidden key/i],
    ['a nested constructor key', v1Text.replace('"id": "opp-alex"', '"constructor": {}, "id": "opp-alex"'), /forbidden key/i],
    ['a missing data section', JSON.stringify({ format: 'tennis-stats-backup', version: 1, exportedAt: 'x' }), /data/i],
  ])('rejects %s with a useful, secret-free error', (_label, raw, message) => {
    const result = error(previewImport(raw));
    expect(result).toMatch(message);
    expect(result).not.toContain('sk-live-123');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it('rejects oversized input before parsing', () => {
    const parse = vi.spyOn(JSON, 'parse');
    expect(error(previewImport(' '.repeat(20 * 1024 * 1024 + 1)))).toMatch(/too large/i);
    expect(parse).not.toHaveBeenCalled(); parse.mockRestore();
  });
  it('reports every rejected record with reasons and cascades through broken match bundles', () => {
    const data = structuredClone(v1.data);
    data.games[1].netErrors = -1;                       // invalid metric in match-1
    data.games.push({ ...data.games[2], id: 'game-x', failedReturns: 0, server: 'player' }); // server-specific metric rule in match-2
    data.sets.push({ ...data.sets[1], id: 'set-orphan', matchId: 'nowhere' });
    data.opponents.push({ ...data.opponents[0], id: 'opp-dup', name: 'x', normalizedName: 'x', extra: 1 });
    data.opponents.push({ ...data.opponents[1], name: 'Other' });          // duplicate id opp-sam
    const preview = ok(previewImport(JSON.stringify({ ...v1, data })));
    const reasons = (entity: string, id: string) => preview.rejected.filter(r => r.entity === entity && r.id === id).flatMap(r => r.reasons).join(' | ');
    expect(reasons('games', 'game-2')).toMatch(/netErrors/);
    expect(reasons('games', 'game-x')).toMatch(/failedReturns/);
    expect(reasons('matches', 'match-1')).toMatch(/part of this match was rejected/i);
    expect(reasons('sets', 'set-1')).toMatch(/match .*rejected/i);
    expect(reasons('tieBreaks', 'tb-1')).toMatch(/rejected/i);
    expect(reasons('sets', 'set-orphan')).toMatch(/match .*missing/i);
    expect(reasons('opponents', 'opp-dup')).toMatch(/unrecognized/i);
    expect(reasons('opponents', 'opp-sam')).toMatch(/duplicate id/i);
    expect(reasons('matches', 'match-2')).toMatch(/opponent .*(missing|rejected)/i);
    expect(preview.records).toEqual({ opponents: [v1.data.opponents[0]], matches: [], sets: [], games: [], tieBreaks: [] });
    expect(preview.counts.games).toEqual({ total: 4, accepted: 0, rejected: 4 });
    expect(preview.counts.opponents).toEqual({ total: 4, accepted: 1, rejected: 3 });
    expect(preview.rejected.every(r => r.reasons.length > 0)).toBe(true);
  });
  it('rejects more than one active match and duplicate ordinals', () => {
    const data = structuredClone(v1.data);
    data.matches[0].status = 'active';
    data.games.push({ ...data.games[2], id: 'game-4' }); // same ordinal as game-3
    const preview = ok(previewImport(JSON.stringify({ ...v1, data })));
    expect(preview.rejected.find(r => r.id === 'match-1')?.reasons.join()).toMatch(/more than one active/i);
    expect(preview.rejected.find(r => r.id === 'game-4')?.reasons.join()).toMatch(/ordinal/i);
    expect(preview.records.matches).toEqual([]);
  });
  it('links opponents duplicated by normalized name inside the file to one opponent', () => {
    const data = structuredClone(v1.data);
    data.opponents.push({ ...data.opponents[0], id: 'opp-alex-2', name: '  ALEX ', normalizedName: 'alex' });
    data.matches[0].opponentId = 'opp-alex-2';
    const preview = ok(previewImport(JSON.stringify({ ...v1, data })));
    expect(preview.remaps).toEqual([{ from: 'opp-alex-2', to: 'opp-alex', name: 'Alex' }]);
    expect(preview.records.matches.find(m => m.id === 'match-1')?.opponentId).toBe('opp-alex');
    expect(preview.records.opponents.map(o => o.id)).toEqual(['opp-alex', 'opp-sam']);
  });
  it('rejects an opponent whose normalizedName does not match the normalized name', () => {
    const data = structuredClone(v1.data);
    data.opponents[0].normalizedName = 'wrong-name';
    const preview = ok(previewImport(JSON.stringify({ ...v1, data })));
    const opponent = preview.rejected.find(record => record.entity === 'opponents' && record.id === 'opp-alex');
    expect(opponent?.reasons.join(' | ')).toMatch(/normalizedName.*normalized.*name/i);
    expect(preview.records.opponents.some(record => record.id === 'opp-alex')).toBe(false);
    expect(preview.rejected.find(record => record.entity === 'matches' && record.id === 'match-1')?.reasons.join(' | ')).toMatch(/opponent.*rejected/i);
  });
});

describe('applyImport', () => {
  it('writes nothing for an invalid file and leaves current data untouched', async () => {
    const repo = await seeded(); const before = await repo.snapshot();
    const writes = (['replaceAll', 'insertRecords', 'saveMatchBundle', 'deleteMatch'] as const).map(name => vi.spyOn(repo, name));
    for (const mode of ['merge', 'replace'] as const) await expect(applyImport(previewImport('{"format":"tennis-stats-backup","version":99}'), mode, repo)).rejects.toThrow(/version 99/);
    writes.forEach(spy => expect(spy).not.toHaveBeenCalled());
    expect(await repo.snapshot()).toEqual(before);
  });
  it('replaces all tennis data transactionally and keeps only drafts that still belong', async () => {
    const repo = await setup();
    await repo.saveMatchBundle(ownBundle('old', 'active'));
    await repo.saveDraft(draft('old-draft', 'old', 'old-s1'));
    const keepRepo = await seeded(); await keepRepo.saveDraft(draft('keep', 'match-2', 'set-2'));
    const result = await applyImport(ok(previewImport(v1Text)), 'replace', repo);
    expect(result).toMatchObject({ mode: 'replace', draftsKept: 0, draftsDiscarded: 1, conflicts: [] });
    expect(result.summary.games).toEqual({ added: 3, skipped: 0, conflicted: 0 });
    expect(await repo.getMatchBundle('old')).toBeUndefined();
    expect((await repo.snapshot()).voiceDrafts).toEqual([]);
    const again = await applyImport(ok(previewImport(v1Text)), 'replace', keepRepo);
    expect(again).toMatchObject({ draftsKept: 1, draftsDiscarded: 0 });
    expect((await keepRepo.getDraft('keep'))?.recording).toBeInstanceOf(Blob);
  });
  it('round-trips export, clear, replace import, export byte-identically', async () => {
    const repo = await seeded(); await repo.saveMatchBundle(ownBundle('extra', 'completed', { ...stamp, id: 'opp-kim', name: 'Kim', normalizedName: 'kim' }));
    const first = serializeBackup(await exportBackup(repo, clock));
    const empty = await setup();
    await applyImport(ok(previewImport(first)), 'replace', empty);
    expect(serializeBackup(await exportBackup(empty, clock))).toBe(first);
  });
  it('rolls back a failed replace, leaving current data unchanged', async () => {
    const repo = await setup(); await repo.saveMatchBundle(ownBundle('old', 'active'));
    const before = await repo.snapshot();
    const preview = ok(previewImport(v1Text));
    preview.records.opponents.push(preview.records.opponents[0]); // tamper after validation: duplicate key fails mid-write
    await expect(applyImport(preview, 'replace', repo)).rejects.toThrow();
    expect(await repo.snapshot()).toEqual(before);
  });
  it('merges by reconciling opponents with the same normalized name and reports the remap', async () => {
    const repo = await setup(); await repo.saveMatchBundle(ownBundle('mine', 'completed'));
    const result = await applyImport(ok(previewImport(v0Text)), 'merge', repo);
    expect(result.remaps).toEqual([{ from: 'legacy-opp-1', to: 'mine-alex', name: 'ALEX' }]);
    expect(result.summary.opponents).toEqual({ added: 0, skipped: 1, conflicted: 0 });
    expect(result.summary.matches).toEqual({ added: 1, skipped: 0, conflicted: 0 });
    expect((await repo.getMatchBundle('legacy-match-1'))?.opponent.id).toBe('mine-alex');
    expect(await repo.listOpponents()).toHaveLength(1);
  });
  it('reports same-id divergent records as conflicts without overwriting them, applying the rest', async () => {
    const repo = await setup();
    const opponent = { ...v1.data.opponents[0] };
    const edited = { opponent, match: { ...v1.data.matches[0], comments: 'my local edit' }, sets: [v1.data.sets[0]], games: v1.data.games.slice(0, 2), tieBreaks: v1.data.tieBreaks };
    await repo.saveMatchBundle(edited);
    const before = await repo.getMatchBundle('match-1');
    const preview = ok(previewImport(v1Text));
    const plan = await previewMerge(preview, repo);
    const result = await applyImport(preview, 'merge', repo);
    expect(result.conflicts).toEqual([{ entity: 'matches', id: 'match-1', reason: expect.stringMatching(/already exists with different details/i) }]);
    expect(plan.conflicts).toEqual(result.conflicts); expect(plan.summary).toEqual(result.summary);
    expect(result.summary).toEqual({ opponents: { added: 1, skipped: 1, conflicted: 0 }, matches: { added: 1, skipped: 0, conflicted: 1 }, sets: { added: 1, skipped: 0, conflicted: 1 }, games: { added: 1, skipped: 0, conflicted: 2 }, tieBreaks: { added: 0, skipped: 0, conflicted: 1 } });
    expect(await repo.getMatchBundle('match-1')).toEqual(before);
    expect((await repo.getMatchBundle('match-2'))?.games).toHaveLength(1);
  });
  it('reports an opponent id conflict and its dependent matches', async () => {
    const repo = await setup();
    await repo.saveMatchBundle(ownBundle('mine', 'completed', { ...stamp, id: 'opp-sam', name: 'Somebody Else', normalizedName: 'somebody else' }));
    const result = await applyImport(ok(previewImport(v1Text)), 'merge', repo);
    expect(result.conflicts).toEqual([
      { entity: 'opponents', id: 'opp-sam', reason: expect.stringMatching(/different details/i) },
      { entity: 'matches', id: 'match-2', reason: expect.stringMatching(/opponent/i) },
    ]);
    expect((await repo.listOpponents()).find(o => o.id === 'opp-sam')?.name).toBe('Somebody Else');
    expect(await repo.getMatchBundle('match-2')).toBeUndefined();
  });
  it('is idempotent: importing the same file twice adds nothing the second time', async () => {
    const repo = await setup();
    await applyImport(ok(previewImport(v1Text)), 'merge', repo);
    const before = await repo.snapshot();
    const again = await applyImport(ok(previewImport(v1Text)), 'merge', repo);
    for (const counts of Object.values(again.summary)) expect(counts.added).toBe(0);
    expect(again.summary.games).toEqual({ added: 0, skipped: 3, conflicted: 0 });
    expect(again.conflicts).toEqual([]);
    expect(await repo.snapshot()).toEqual(before);
  });
  it('never creates a second active match: the imported active match is a reported conflict', async () => {
    const repo = await setup(); await repo.saveMatchBundle(ownBundle('mine', 'active'));
    const result = await applyImport(ok(previewImport(v1Text)), 'merge', repo);
    expect(result.conflicts).toEqual([{ entity: 'matches', id: 'match-2', reason: expect.stringMatching(/active match already exists/i) }]);
    expect((await repo.listMatches({ status: 'active' })).map(m => m.id)).toEqual(['mine']);
    expect((await repo.getMatchBundle('match-1'))?.match.status).toBe('completed');
  });
  it('reports new matches whose child ids collide with existing records as conflicts', async () => {
    const repo = await setup();
    const own = ownBundle('mine', 'completed'); own.games[0].id = 'game-3';
    await repo.saveMatchBundle(own);
    const result = await applyImport(ok(previewImport(v1Text)), 'merge', repo);
    expect(result.conflicts).toContainEqual({ entity: 'matches', id: 'match-2', reason: expect.stringMatching(/ids already exist/i) });
    expect(await repo.getMatchBundle('match-2')).toBeUndefined();
  });
  it('rolls back a failed merge, leaving current data unchanged', async () => {
    const repo = await setup(); await repo.saveMatchBundle(ownBundle('mine', 'completed'));
    const before = await repo.snapshot();
    const preview = ok(previewImport(v1Text));
    preview.records.games.push({ ...preview.records.games[0], id: 'mine-g1' }); // tamper after validation: collides mid-write
    vi.spyOn(repo, 'snapshot').mockResolvedValueOnce({ ...before, games: [] }); // stale read: the collision is only found inside the write transaction
    await expect(applyImport(preview, 'merge', repo)).rejects.toThrow();
    expect(await repo.snapshot()).toEqual(before);
  });
});

describe('clearAllData', () => {
  it('removes every tennis record and draft in one replace and reports what was removed', async () => {
    const repo = await seeded();
    const match = (await repo.listMatches())[0];
    await repo.saveDraft(draft('d1', match.id, ''));
    const removed = await clearAllData(repo);
    expect(removed).toEqual({ opponents: 2, matches: 2, sets: 2, games: 3, tieBreaks: 1, voiceDrafts: 1 });
    const after = await repo.snapshot();
    expect(after).toMatchObject({ opponents: [], matches: [], sets: [], games: [], tieBreaks: [], voiceDrafts: [] });
    expect(after.dataVersion).toBeGreaterThan(0);
    await repo.saveMatchBundle(ownBundle('after-clear', 'active'));
    expect((await repo.listMatches()).map(m => m.id)).toEqual(['after-clear']);
  });

  it('leaves data untouched when the write fails', async () => {
    const repo = await seeded(); const before = JSON.stringify(await repo.snapshot());
    vi.spyOn(repo, 'replaceAll').mockRejectedValueOnce(new Error('boom'));
    await expect(clearAllData(repo)).rejects.toThrow();
    expect(JSON.stringify(await repo.snapshot())).toBe(before);
  });
});
