import { z } from 'zod';
import type { Clock, TennisRepository } from './ports';
import type { DatabaseSnapshot, Game, Match, Opponent, TennisRecords, TennisSet, TieBreak, VoiceDraft } from '../domain/model';
import { GAME_COMMENT_MAX_LENGTH, normalizeOpponentName, validateGame } from '../domain/validation';

/*
 * Backup FILE format versions are independent of the IndexedDB DATA_VERSION:
 *  - file v0: legacy raw table dump `{ dataVersion: 0, opponents, matches, sets, games, tieBreaks, drafts? }` (entity shapes of DB data version 0).
 *  - file v1: `{ format, version: 1, exportedAt, data: { opponents, matches, sets, games, tieBreaks } }`; games have no `unforcedErrors`/`comments`.
 *  - file v2: same envelope with `version: 2`; every game also carries `unforcedErrors` and `comments` (both nullable, both required).
 * Tennis entity shapes are identical in DB data versions 0, 1 and 2 (only drafts changed) and games gained two fields in data version 3.
 * Backups never contain drafts, so files v0 and v1 are normalized in memory to the current shape (new game fields become null);
 * imports are written at the repository's own stored data version.
 */
export const BACKUP_FORMAT = 'tennis-stats-backup';
export const BACKUP_VERSION = 2;
export const MAX_BACKUP_CHARS = 20 * 1024 * 1024;
const MAX_RECORDS = 100_000;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export type EntityType = keyof TennisRecords;
export const ENTITY_TYPES: readonly EntityType[] = ['opponents', 'matches', 'sets', 'games', 'tieBreaks'];
export interface BackupV2 { format: typeof BACKUP_FORMAT; version: 2; exportedAt: string; data: TennisRecords }
export interface RejectedRecord { entity: EntityType; /** Position in the file's array for this entity type. */ index: number; id: string | null; reasons: string[] }
/** Matches of opponent `from` are linked to opponent `to` because both have the same normalized name; `name` is the name of `to`. */
export interface OpponentRemap { from: string; to: string; name: string }
export type PreviewCounts = Record<EntityType, { total: number; accepted: number; rejected: number }>;
export interface ImportPreviewOk {
  ok: true;
  sourceVersion: 0 | 1 | 2;
  exportedAt: string | null;
  /** Accepted records only, in canonical order, already migrated to the current file version. */
  records: TennisRecords;
  counts: PreviewCounts;
  rejected: RejectedRecord[];
  /** Opponents merged inside the file by normalized name (the duplicates are also listed in `rejected`). */
  remaps: OpponentRemap[];
  warnings: string[];
}
export interface ImportPreviewError { ok: false; error: string }
export type ImportPreview = ImportPreviewOk | ImportPreviewError;
export type ImportMode = 'merge' | 'replace';
export type ImportSummary = Record<EntityType, { added: number; skipped: number; conflicted: number }>;
export interface ImportConflict { entity: 'opponents' | 'matches'; id: string; reason: string }
export interface MergePlan { additions: TennisRecords; summary: ImportSummary; conflicts: ImportConflict[]; remaps: OpponentRemap[] }
export interface ImportResult {
  mode: ImportMode;
  summary: ImportSummary;
  /** Merge only: records that were NOT written because they diverge from existing data. Each match conflict covers its whole bundle. */
  conflicts: ImportConflict[];
  /** Opponent links made inside the file and (merge) against existing opponents. */
  remaps: OpponentRemap[];
  rejected: RejectedRecord[];
  /** Replace only: existing voice drafts kept because their match and set are in the imported data, and drafts removed. */
  draftsKept: number;
  draftsDiscarded: number;
}

// ---------- canonical form (fixed key order, fixed entity order) ----------

const canonical = {
  opponents: (o: Opponent): Opponent => ({ id: o.id, name: o.name, normalizedName: o.normalizedName, createdAt: o.createdAt, updatedAt: o.updatedAt }),
  matches: (m: Match): Match => ({ id: m.id, opponentId: m.opponentId, playedAt: m.playedAt, format: m.format, firstServer: m.firstServer, status: m.status, comments: m.comments, createdAt: m.createdAt, updatedAt: m.updatedAt }),
  sets: (s: TennisSet): TennisSet => ({ id: s.id, matchId: s.matchId, ordinal: s.ordinal, kind: s.kind, status: s.status, tieBreakId: s.tieBreakId, createdAt: s.createdAt, updatedAt: s.updatedAt }),
  games: (g: Game): Game => ({ id: g.id, setId: g.setId, ordinal: g.ordinal, server: g.server, result: g.result, score: g.score === null ? null : { player: g.score.player, opponent: g.score.opponent }, netErrors: g.netErrors, wideErrors: g.wideErrors, longErrors: g.longErrors, doubleFaults: g.doubleFaults, failedReturns: g.failedReturns, unforcedErrors: g.unforcedErrors ?? null, comments: g.comments ?? null, createdAt: g.createdAt, updatedAt: g.updatedAt }),
  tieBreaks: (t: TieBreak): TieBreak => ({ id: t.id, setId: t.setId, kind: t.kind, playerPoints: t.playerPoints, opponentPoints: t.opponentPoints, netErrors: t.netErrors, wideErrors: t.wideErrors, longErrors: t.longErrors, doubleFaults: t.doubleFaults, createdAt: t.createdAt, updatedAt: t.updatedAt }),
};
const cmp = (a: string | number, b: string | number) => (a < b ? -1 : a > b ? 1 : 0);
const order = {
  opponents: (a: Opponent, b: Opponent) => cmp(a.normalizedName, b.normalizedName) || cmp(a.id, b.id),
  matches: (a: Match, b: Match) => cmp(a.playedAt, b.playedAt) || cmp(a.id, b.id),
  sets: (a: TennisSet, b: TennisSet) => cmp(a.matchId, b.matchId) || cmp(a.ordinal, b.ordinal) || cmp(a.id, b.id),
  games: (a: Game, b: Game) => cmp(a.setId, b.setId) || cmp(a.ordinal, b.ordinal) || cmp(a.id, b.id),
  tieBreaks: (a: TieBreak, b: TieBreak) => cmp(a.setId, b.setId) || cmp(a.id, b.id),
};
function canonicalRecords(records: TennisRecords): TennisRecords {
  return {
    opponents: records.opponents.map(canonical.opponents).sort(order.opponents),
    matches: records.matches.map(canonical.matches).sort(order.matches),
    sets: records.sets.map(canonical.sets).sort(order.sets),
    games: records.games.map(canonical.games).sort(order.games),
    tieBreaks: records.tieBreaks.map(canonical.tieBreaks).sort(order.tieBreaks),
  };
}
const opponentKey = (o: Opponent) => normalizeOpponentName(o.normalizedName).toLowerCase();

// ---------- export ----------

export async function exportBackup(repo: TennisRepository, clock: Clock): Promise<BackupV2> {
  const snapshot = await repo.snapshot();
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: clock.now(), data: canonicalRecords(snapshot) };
}
/** Human-inspectable, byte-deterministic JSON for a backup. */
export function serializeBackup(backup: BackupV2): string {
  return `${JSON.stringify({ format: backup.format, version: backup.version, exportedAt: backup.exportedAt, data: canonicalRecords(backup.data) }, null, 2)}\n`;
}
/** `tennis-stats-backup-v2-YYYY-MM-DD.json`, using the UTC date of the given ISO instant (from the injected clock). */
export function backupFileName(nowIso: string): string {
  const date = new Date(nowIso);
  if (Number.isNaN(date.getTime())) throw new Error('Invalid backup date');
  return `tennis-stats-backup-v${BACKUP_VERSION}-${date.toISOString().slice(0, 10)}.json`;
}

// ---------- schemas ----------

const nonBlank = z.string().min(1).max(200).refine(value => value.trim() !== '', 'Must not be blank');
const id = nonBlank;
const stamp = z.string().min(1).max(100);
const metric = z.number().int().min(0).max(10_000).nullable();
const point = z.enum(['0', '15', '30', '40', 'AD']);
const gameBase = { id, setId: id, ordinal: z.number().int().min(0).max(1_000), server: z.enum(['player', 'opponent']), result: z.enum(['won', 'lost']), score: z.strictObject({ player: point, opponent: point }).nullable(), netErrors: metric, wideErrors: metric, longErrors: metric, doubleFaults: metric, failedReturns: metric };
const gameTimes = { createdAt: stamp, updatedAt: stamp };
const gameTotals = { unforcedErrors: metric, comments: z.string().max(GAME_COMMENT_MAX_LENGTH).nullable() };
/** File v0/v1 games: the old strict keys; the new fields are normalized to null. */
const gameV1 = z.strictObject({ ...gameBase, ...gameTimes }).transform((game): Game => ({ ...game, unforcedErrors: null, comments: null }));
/** File v2 games: both new keys are required. */
const gameV2 = z.strictObject({ ...gameBase, ...gameTotals, ...gameTimes });
const schemas = {
  opponents: z.strictObject({ id, name: nonBlank, normalizedName: nonBlank, createdAt: stamp, updatedAt: stamp }),
  matches: z.strictObject({ id, opponentId: id, playedAt: stamp, format: z.enum(['twoSetsSuperTiebreak', 'openPractice', 'oneSet', 'bestOfThree']), firstServer: z.enum(['player', 'opponent']), status: z.enum(['active', 'completed', 'abandoned']), comments: z.string().max(10_000).nullable(), createdAt: stamp, updatedAt: stamp }),
  sets: z.strictObject({ id, matchId: id, ordinal: z.number().int().min(1).max(100), kind: z.enum(['standard', 'decidingSuperTiebreak']), status: z.enum(['active', 'completed', 'unfinished']), tieBreakId: id.nullable(), createdAt: stamp, updatedAt: stamp }),
  tieBreaks: z.strictObject({ id, setId: id, kind: z.enum(['standard', 'super']), playerPoints: z.number().int().min(0).max(1_000), opponentPoints: z.number().int().min(0).max(1_000), netErrors: metric, wideErrors: metric, longErrors: metric, doubleFaults: metric, createdAt: stamp, updatedAt: stamp }),
};
const entitySchemas = (version: 0 | 1 | 2) => ({ ...schemas, games: version === 2 ? gameV2 : gameV1 });
const recordArray = z.array(z.unknown()).max(MAX_RECORDS);
const rawData = z.strictObject({ opponents: recordArray, matches: recordArray, sets: recordArray, games: recordArray, tieBreaks: recordArray });
const v1Envelope = z.strictObject({ format: z.literal(BACKUP_FORMAT), version: z.literal(1), exportedAt: stamp, data: rawData });
const v2Envelope = z.strictObject({ format: z.literal(BACKUP_FORMAT), version: z.literal(2), exportedAt: stamp, data: rawData });
const v0Envelope = z.strictObject({ dataVersion: z.literal(0), opponents: recordArray, matches: recordArray, sets: recordArray, games: recordArray, tieBreaks: recordArray, drafts: recordArray.optional(), voiceDrafts: recordArray.optional(), metadata: recordArray.optional() });
type RawData = z.infer<typeof rawData>;

function describeIssues(error: z.ZodError): string[] {
  // Paths and messages only; never the received values (they could contain anything).
  return error.issues.map(issue => `${issue.path.length ? `${issue.path.join('.')}: ` : ''}${issue.message}`);
}

// ---------- preview ----------

const fail = (error: string): ImportPreviewError => ({ ok: false, error });
const supported = 'This app can read backup versions 0, 1 and 2.';

function findForbiddenKey(root: unknown): string | null {
  const stack: unknown[] = [root];
  while (stack.length) {
    const value = stack.pop();
    if (!value || typeof value !== 'object') continue;
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_KEYS.has(key)) return key;
      stack.push((value as Record<string, unknown>)[key]);
    }
  }
  return null;
}

/** Parses, validates and migrates a backup file in memory. Never touches stored data. */
export function previewImport(raw: string): ImportPreview {
  if (typeof raw !== 'string') return fail('The backup file could not be read.');
  if (raw.length > MAX_BACKUP_CHARS) return fail('The backup file is too large (the limit is 20 MB).');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return fail('The file is not valid JSON, so it is not a Tennis Stats backup.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail('The file is not a Tennis Stats backup.');
  const forbidden = findForbiddenKey(parsed);
  if (forbidden) return fail(`The backup contains a forbidden key ("${forbidden}") and was not read.`);
  const file = parsed as Record<string, unknown>;
  if ('format' in file) {
    if (file.format !== BACKUP_FORMAT) return fail('The file is not a Tennis Stats backup.');
    if (file.version !== 1 && file.version !== 2) return fail(`Unsupported backup version ${typeof file.version === 'number' && Number.isFinite(file.version) ? file.version : '(unrecognized)'}. ${supported}`);
    const envelope = (file.version === 2 ? v2Envelope : v1Envelope).safeParse(file);
    if (!envelope.success) return fail(`The backup file structure is invalid: ${describeIssues(envelope.error).join('; ')}`);
    return validateRecords(envelope.data.data, file.version, envelope.data.exportedAt, []);
  }
  if ('dataVersion' in file) {
    if (file.dataVersion !== 0) return fail(`Unsupported backup version (legacy data version ${typeof file.dataVersion === 'number' && Number.isFinite(file.dataVersion) ? file.dataVersion : 'unrecognized'}). ${supported}`);
    const envelope = v0Envelope.safeParse(file);
    if (!envelope.success) return fail(`The legacy backup file structure is invalid: ${describeIssues(envelope.error).join('; ')}`);
    return validateRecords(...migrateV0(envelope.data));
  }
  return fail('The file is not a Tennis Stats backup.');
}

/** File v0 -> v1 shape, in memory (validated and normalized to the current shape later): wrap the table dump in the v1 envelope; drafts are never imported (reported as a warning). */
function migrateV0(file: z.infer<typeof v0Envelope>): [RawData, 0, null, string[]] {
  const drafts = (file.drafts?.length ?? 0) + (file.voiceDrafts?.length ?? 0);
  const warnings = drafts ? [`${drafts} voice draft${drafts === 1 ? '' : 's'} in this legacy file ${drafts === 1 ? 'is' : 'are'} not imported: backups never restore drafts or recordings.`] : [];
  if (file.metadata?.length) warnings.push('Legacy database metadata in this file is not imported.');
  return [{ opponents: file.opponents, matches: file.matches, sets: file.sets, games: file.games, tieBreaks: file.tieBreaks }, 0, null, warnings];
}

/** `parent` is the raw matchId (sets) or setId (games, tie-breaks) so a malformed child still breaks its match bundle. */
interface Candidate<T> { index: number; id: string | null; parent: string | null; value: T | null; reasons: string[] }
type Candidates = { [K in EntityType]: Candidate<TennisRecords[K][number]>[] };

function validateRecords(data: RawData, sourceVersion: 0 | 1 | 2, exportedAt: string | null, warnings: string[]): ImportPreviewOk {
  const all = {} as Candidates;
  for (const entity of ENTITY_TYPES) {
    (all as Record<EntityType, Candidate<unknown>[]>)[entity] = data[entity].map((item, index) => {
      const field = (name: string) => { const v = item && typeof item === 'object' ? (item as Record<string, unknown>)[name] : undefined; return typeof v === 'string' ? v.slice(0, 200) : null; };
      const parent = entity === 'sets' ? field('matchId') : entity === 'games' || entity === 'tieBreaks' ? field('setId') : null;
      const result = entitySchemas(sourceVersion)[entity].safeParse(item);
      if (!result.success) return { index, id: field('id'), parent, value: null, reasons: describeIssues(result.error) };
      const value = result.data as TennisRecords[EntityType][number];
      const reasons = entity === 'games'
        ? gameIssues(value as Game)
        : entity === 'opponents' && (value as Opponent).normalizedName !== normalizeOpponentName((value as Opponent).name).toLowerCase()
          ? ['normalizedName must equal the normalized lowercase name']
          : [];
      return { index, id: field('id'), parent, value, reasons };
    });
  }
  const accepted = <K extends EntityType>(entity: K) => all[entity].filter(c => c.value && !c.reasons.length) as (Candidate<TennisRecords[K][number]> & { value: TennisRecords[K][number] })[];
  const reject = (candidate: Candidate<unknown>, reason: string) => { if (!candidate.reasons.includes(reason)) candidate.reasons.push(reason); };

  // Duplicate ids inside the file are ambiguous: every copy is rejected.
  for (const entity of ENTITY_TYPES) {
    const seen = new Map<string, number>();
    for (const c of all[entity]) if (c.value) seen.set(c.value.id, (seen.get(c.value.id) ?? 0) + 1);
    for (const c of all[entity]) if (c.value && seen.get(c.value.id)! > 1) reject(c, 'Duplicate id in this file');
  }

  // Opponents with the same normalized name inside the file become one opponent (lowest id wins).
  const remaps: OpponentRemap[] = [];
  const byKey = new Map<string, Opponent>();
  for (const c of [...accepted('opponents')].sort((a, b) => cmp(a.value.id, b.value.id))) {
    const keep = byKey.get(opponentKey(c.value));
    if (!keep) { byKey.set(opponentKey(c.value), c.value); continue; }
    remaps.push({ from: c.value.id, to: keep.id, name: keep.name });
    reject(c, `Same name as opponent ${keep.id}; its matches are linked to that opponent`);
  }
  const remapped = new Map(remaps.map(r => [r.from, r.to]));
  for (const c of all.matches) if (c.value && remapped.has(c.value.opponentId)) c.value = { ...c.value, opponentId: remapped.get(c.value.opponentId)! };

  // Referential integrity to a fixpoint. A match bundle (match + sets + games + tie-breaks) is accepted whole or not at all.
  const setOwner = new Map<string, string>();
  for (const c of all.sets) if (c.id !== null && c.parent !== null && !setOwner.has(c.id)) setOwner.set(c.id, c.parent);
  const activeMatches = accepted('matches').filter(c => c.value.status === 'active');
  if (activeMatches.length > 1) activeMatches.forEach(c => reject(c, 'More than one active match in this file'));
  for (let changed = true; changed;) {
    changed = false;
    const mark = (c: Candidate<unknown>, reason: string) => { reject(c, reason); changed = true; };
    const opponents = new Set(accepted('opponents').map(c => c.value.id));
    const matches = new Set(accepted('matches').map(c => c.value.id));
    const sets = new Map(accepted('sets').map(c => [c.value.id, c.value]));
    const tieBreaks = new Map(accepted('tieBreaks').map(c => [c.value.id, c.value]));
    for (const c of accepted('matches')) if (!opponents.has(c.value.opponentId)) mark(c, `Opponent ${c.value.opponentId} is missing or rejected`);
    for (const c of accepted('sets')) {
      if (!matches.has(c.value.matchId)) mark(c, `Match ${c.value.matchId} is missing or rejected`);
      else if (c.value.tieBreakId !== null && tieBreaks.get(c.value.tieBreakId)?.setId !== c.value.id) mark(c, `Tie-break ${c.value.tieBreakId} is missing, rejected or belongs to another set`);
    }
    for (const c of accepted('games')) if (!sets.has(c.value.setId)) mark(c, `Set ${c.value.setId} is missing or rejected`);
    for (const c of accepted('tieBreaks')) if (sets.get(c.value.setId)?.tieBreakId !== c.value.id) mark(c, `Set ${c.value.setId} is missing, rejected or does not link this tie-break`);
    markDuplicateOrdinals(accepted('sets'), s => s.matchId, mark);
    markDuplicateOrdinals(accepted('games'), g => g.setId, mark);
    const brokenMatches = new Set<string>();
    for (const c of all.sets) if (c.reasons.length && c.parent !== null) brokenMatches.add(c.parent);
    for (const entity of ['games', 'tieBreaks'] as const) for (const c of all[entity]) if (c.reasons.length && c.parent !== null && setOwner.has(c.parent)) brokenMatches.add(setOwner.get(c.parent)!);
    for (const c of accepted('matches')) if (brokenMatches.has(c.value.id)) mark(c, 'Part of this match was rejected');
  }

  const records = canonicalRecords({ opponents: accepted('opponents').map(c => c.value), matches: accepted('matches').map(c => c.value), sets: accepted('sets').map(c => c.value), games: accepted('games').map(c => c.value), tieBreaks: accepted('tieBreaks').map(c => c.value) });
  const rejected: RejectedRecord[] = [];
  const counts = {} as PreviewCounts;
  for (const entity of ENTITY_TYPES) {
    const bad = all[entity].filter(c => c.reasons.length);
    bad.forEach(c => rejected.push({ entity, index: c.index, id: c.id, reasons: [...c.reasons] }));
    counts[entity] = { total: all[entity].length, accepted: all[entity].length - bad.length, rejected: bad.length };
  }
  return { ok: true, sourceVersion, exportedAt, records, counts, rejected, remaps, warnings };
}

function gameIssues(game: Game): string[] {
  const result = validateGame(game);
  return result.ok ? [] : result.issues.map(issue => `${issue.field}: ${issue.message}`);
}
function markDuplicateOrdinals<T extends { ordinal: number }>(items: { value: T }[], parent: (item: T) => string, mark: (c: Candidate<unknown>, reason: string) => void) {
  const seen = new Map<string, number>();
  for (const c of items) { const key = `${parent(c.value)}\u0000${c.value.ordinal}`; seen.set(key, (seen.get(key) ?? 0) + 1); }
  for (const c of items) if (seen.get(`${parent(c.value)}\u0000${c.value.ordinal}`)! > 1) mark(c as Candidate<unknown>, `Duplicate ordinal ${c.value.ordinal} under the same parent`);
}

// ---------- merge planning ----------

const emptySummary = (): ImportSummary => ({ opponents: { added: 0, skipped: 0, conflicted: 0 }, matches: { added: 0, skipped: 0, conflicted: 0 }, sets: { added: 0, skipped: 0, conflicted: 0 }, games: { added: 0, skipped: 0, conflicted: 0 }, tieBreaks: { added: 0, skipped: 0, conflicted: 0 } });
interface Bundle { match: Match; sets: TennisSet[]; games: Game[]; tieBreaks: TieBreak[] }
function bundles(records: TennisRecords): Map<string, Bundle> {
  const result = new Map<string, Bundle>(records.matches.map(match => [match.id, { match, sets: [], games: [], tieBreaks: [] }]));
  const setOwner = new Map<string, Bundle>();
  for (const set of records.sets) { const bundle = result.get(set.matchId); if (bundle) { bundle.sets.push(set); setOwner.set(set.id, bundle); } }
  for (const game of records.games) setOwner.get(game.setId)?.games.push(game);
  for (const tieBreak of records.tieBreaks) setOwner.get(tieBreak.setId)?.tieBreaks.push(tieBreak);
  return result;
}
const signature = (bundle: Bundle) => JSON.stringify(canonicalRecords({ opponents: [], matches: [bundle.match], sets: bundle.sets, games: bundle.games, tieBreaks: bundle.tieBreaks }));

/** Pure merge decision: what would be added, skipped (identical / reconciled) and conflicted against `current`. */
export function planMerge(preview: ImportPreviewOk, current: TennisRecords): MergePlan {
  const summary = emptySummary(); const conflicts: ImportConflict[] = []; const remaps: OpponentRemap[] = [...preview.remaps];
  const additions: TennisRecords = { opponents: [], matches: [], sets: [], games: [], tieBreaks: [] };
  const existingById = new Map(current.opponents.map(o => [o.id, o]));
  const existingByKey = new Map<string, Opponent>();
  for (const o of [...current.opponents].sort((a, b) => cmp(a.id, b.id))) if (!existingByKey.has(opponentKey(o))) existingByKey.set(opponentKey(o), o);
  const opponentTarget = new Map<string, string>(); const conflictedOpponents = new Set<string>();
  for (const opponent of preview.records.opponents) {
    const same = existingById.get(opponent.id);
    if (same) {
      if (JSON.stringify(canonical.opponents(same)) === JSON.stringify(canonical.opponents(opponent))) { summary.opponents.skipped++; opponentTarget.set(opponent.id, opponent.id); }
      else { summary.opponents.conflicted++; conflictedOpponents.add(opponent.id); conflicts.push({ entity: 'opponents', id: opponent.id, reason: 'An opponent with this id already exists with different details' }); }
      continue;
    }
    const namesake = existingByKey.get(opponentKey(opponent));
    if (namesake) { summary.opponents.skipped++; opponentTarget.set(opponent.id, namesake.id); remaps.push({ from: opponent.id, to: namesake.id, name: namesake.name }); continue; }
    summary.opponents.added++; opponentTarget.set(opponent.id, opponent.id); additions.opponents.push(opponent);
  }
  const existingBundles = bundles(current);
  const taken = { sets: new Set(current.sets.map(s => s.id)), games: new Set(current.games.map(g => g.id)), tieBreaks: new Set(current.tieBreaks.map(t => t.id)) };
  let activeExists = current.matches.some(m => m.status === 'active');
  for (const imported of bundles(preview.records).values()) {
    const bundle = { ...imported, match: { ...imported.match, opponentId: opponentTarget.get(imported.match.opponentId) ?? imported.match.opponentId } };
    const tally = (kind: 'added' | 'skipped' | 'conflicted') => { summary.matches[kind]++; summary.sets[kind] += bundle.sets.length; summary.games[kind] += bundle.games.length; summary.tieBreaks[kind] += bundle.tieBreaks.length; };
    const conflict = (reason: string) => { tally('conflicted'); conflicts.push({ entity: 'matches', id: bundle.match.id, reason }); };
    if (conflictedOpponents.has(imported.match.opponentId)) { conflict('Its opponent conflicts with an existing opponent'); continue; }
    const existing = existingBundles.get(bundle.match.id);
    if (existing) { if (signature(existing) === signature(bundle)) tally('skipped'); else conflict('A match with this id already exists with different details'); continue; }
    if (current.matches.some(m => m.id === bundle.match.id)) { conflict('A match with this id already exists with different details'); continue; }
    if (bundle.sets.some(s => taken.sets.has(s.id)) || bundle.games.some(g => taken.games.has(g.id)) || bundle.tieBreaks.some(t => taken.tieBreaks.has(t.id))) { conflict('Some of its set, game or tie-break ids already exist in other records'); continue; }
    if (bundle.match.status === 'active' && activeExists) { conflict('An active match already exists; finish or abandon it before importing another active match'); continue; }
    if (bundle.match.status === 'active') activeExists = true;
    tally('added');
    additions.matches.push(bundle.match); additions.sets.push(...bundle.sets); additions.games.push(...bundle.games); additions.tieBreaks.push(...bundle.tieBreaks);
  }
  return { additions, summary, conflicts, remaps };
}

/** Read-only: what a merge would do against the current data (for showing conflicts before the user confirms). */
export async function previewMerge(preview: ImportPreviewOk, repo: TennisRepository): Promise<MergePlan> {
  return planMerge(preview, await repo.snapshot());
}

// ---------- apply ----------

function keptDrafts(drafts: VoiceDraft[], records: TennisRecords): VoiceDraft[] {
  const sets = new Map(records.sets.map(s => [s.id, s.matchId]));
  const matches = new Set(records.matches.map(m => m.id));
  return drafts.filter(d => matches.has(d.matchId) && (d.setId === '' || sets.get(d.setId) === d.matchId));
}

/**
 * Applies a previewed import in one repository transaction. Replace swaps all tennis data for the accepted records;
 * merge inserts only new, non-conflicting records (conflicts are reported, never overwritten). An invalid preview writes nothing.
 */
export async function applyImport(preview: ImportPreview, mode: ImportMode, repo: TennisRepository): Promise<ImportResult> {
  if (!preview.ok) throw new Error(preview.error);
  if (mode !== 'merge' && mode !== 'replace') throw new Error('Unknown import mode');
  const current: DatabaseSnapshot = await repo.snapshot();
  if (mode === 'replace') {
    const records = preview.records;
    const voiceDrafts = keptDrafts(current.voiceDrafts, records);
    await repo.replaceAll({ dataVersion: current.dataVersion, ...records, voiceDrafts });
    const summary = emptySummary();
    for (const entity of ENTITY_TYPES) summary[entity].added = records[entity].length;
    return { mode, summary, conflicts: [], remaps: [...preview.remaps], rejected: preview.rejected, draftsKept: voiceDrafts.length, draftsDiscarded: current.voiceDrafts.length - voiceDrafts.length };
  }
  const plan = planMerge(preview, current);
  if (ENTITY_TYPES.some(entity => plan.additions[entity].length)) await repo.insertRecords(plan.additions);
  return { mode, summary: plan.summary, conflicts: plan.conflicts, remaps: plan.remaps, rejected: preview.rejected, draftsKept: current.voiceDrafts.length, draftsDiscarded: 0 };
}

// ---------- clear ----------

export type ClearedCounts = Record<EntityType | 'voiceDrafts', number>;
/** Deletes every tennis record and voice draft in one repository transaction. Local-storage AI settings are not touched. */
export async function clearAllData(repo: TennisRepository): Promise<ClearedCounts> {
  const current = await repo.snapshot();
  await repo.replaceAll({ dataVersion: current.dataVersion, opponents: [], matches: [], sets: [], games: [], tieBreaks: [], voiceDrafts: [] });
  return { opponents: current.opponents.length, matches: current.matches.length, sets: current.sets.length, games: current.games.length, tieBreaks: current.tieBreaks.length, voiceDrafts: current.voiceDrafts.length };
}
