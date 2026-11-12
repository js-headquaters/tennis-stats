import type { Clock, IdGenerator, TennisRepository } from './ports';
import type { Game, MatchBundle, MatchFormat, Server, TennisSet, TieBreak } from '../domain/model';
import { normalizeOpponentName, validateGame } from '../domain/validation';
import { decidingStoredSet, evaluateMatch, evaluateSet, evaluateStoredMatch, evaluateStoredSet, inferServer } from '../domain/scoring';

export interface MatchServiceDeps { repository: TennisRepository; clock: Clock; ids: IdGenerator }
export interface StartMatchInput { opponentName?: string; opponentId?: string; playedAt: string; format?: MatchFormat; firstServer: Server }
const MATCH_FORMATS: readonly MatchFormat[] = ['twoSetsSuperTiebreak', 'openPractice', 'oneSet', 'bestOfThree'];
const conflict = () => new Error('An active match exists. Complete or abandon it before starting another.');

export async function startMatch(input: StartMatchInput, { repository, clock, ids }: MatchServiceDeps): Promise<MatchBundle> {
  if (await repository.getActiveMatch()) throw conflict();
  const name = normalizeOpponentName(input.opponentName ?? '');
  const opponents = await repository.listOpponents();
  let opponent = input.opponentId ? opponents.find(o => o.id === input.opponentId) : opponents.find(o => o.normalizedName.toLowerCase() === name.toLowerCase());
  if (input.opponentId && !opponent) throw new Error('Opponent not found');
  if (!opponent && !name) throw new Error('Enter an opponent name');
  if (!Number.isFinite(Date.parse(input.playedAt))) throw new Error('Enter a valid date and time');
  if (input.firstServer !== 'player' && input.firstServer !== 'opponent') throw new Error('Choose the first server');
  const now = clock.now();
  if (!opponent) opponent = { id: ids.next(), name, normalizedName: name.toLowerCase(), createdAt: now, updatedAt: now };
  const matchId = ids.next();
  const bundle: MatchBundle = {
    opponent,
    match: { id: matchId, opponentId: opponent.id, playedAt: input.playedAt, format: input.format ?? 'twoSetsSuperTiebreak', firstServer: input.firstServer, status: 'active', comments: null, createdAt: now, updatedAt: now },
    sets: [{ id: ids.next(), matchId, ordinal: 1, kind: 'standard', status: 'active', tieBreakId: null, createdAt: now, updatedAt: now }],
    games: [], tieBreaks: [],
  };
  try { await repository.saveMatchBundle(bundle); }
  catch (error) { if (await repository.getActiveMatch()) throw conflict(); throw error; }
  return bundle;
}
export async function abandonActiveMatch(id: string, { repository, clock }: MatchServiceDeps): Promise<void> {
  await repository.abandonMatch(id, clock.now());
}

export function nextGameServer(bundle: MatchBundle): Server {
  const orderedSets = [...bundle.sets].sort((a, b) => a.ordinal - b.ordinal);
  let next = bundle.match.firstServer;
  for (const set of orderedSets) {
    const games = bundle.games.filter(game => game.setId === set.id).sort((a, b) => a.ordinal - b.ordinal);
    for (const game of games) next = inferServer(game.server, 1);
    if (set.status === 'completed' && bundle.tieBreaks.some(t => t.id === set.tieBreakId && t.kind === 'standard')) next = inferServer(next, 1);
  }
  return next;
}

export type GameInput = Pick<Game, 'result' | 'netErrors' | 'wideErrors' | 'longErrors' | 'doubleFaults' | 'failedReturns'> & { server?: Server; score?: Game['score'] };

function completeSet(bundle: MatchBundle, set: TennisSet, now: string, ids: IdGenerator) {
  set.status = 'completed'; set.updatedAt = now;
  const match = evaluateStoredMatch(bundle);
  if (match.complete) { bundle.match.status = 'completed'; return; }
  const kind = bundle.match.format === 'twoSetsSuperTiebreak' && match.playerSets === 1 && match.opponentSets === 1 ? 'decidingSuperTiebreak' : 'standard';
  bundle.sets.push({ id: ids.next(), matchId: bundle.match.id, ordinal: Math.max(...bundle.sets.map(item => item.ordinal)) + 1, kind, status: 'active', tieBreakId: null, createdAt: now, updatedAt: now });
}

export async function addGames(matchId: string, inputs: GameInput[], { repository, clock, ids }: MatchServiceDeps): Promise<MatchBundle> {
  const found = await repository.getMatchBundle(matchId);
  if (!found) throw new Error('Match not found');
  const bundle = prepareGames(found, inputs, { clock, ids });
  await repository.saveMatchBundle(bundle);
  return bundle;
}

export function prepareGames(found: MatchBundle, inputs: GameInput[], { clock, ids }: Pick<MatchServiceDeps, 'clock' | 'ids'>): MatchBundle {
  const bundle = structuredClone(found);
  if (bundle.match.status !== 'active') throw new Error('Match is not active');
  if (!Array.isArray(inputs) || inputs.length === 0) throw new Error('Add at least one game');
  const now = clock.now();
  for (const input of inputs) {
    const set = bundle.sets.find(item => item.status === 'active');
    if (!set || set.kind !== 'standard' || bundle.match.status !== 'active') throw new Error('No active standard set for game entry');
    const score = evaluateStoredSet(bundle, set);
    if (score.playerGames === 6 && score.opponentGames === 6) throw new Error('Complete the tie-break before adding games');
    const existing = bundle.games.filter(game => game.setId === set.id);
    const game: Game = { ...input, id: ids.next(), setId: set.id, ordinal: Math.max(0, ...existing.map(item => item.ordinal)) + 1, server: input.server ?? nextGameServer(bundle), score: input.score ?? null, createdAt: now, updatedAt: now };
    if (game.result !== 'won' && game.result !== 'lost') throw new Error('Choose whether the game was won or lost');
    const valid = validateGame(game);
    if (!valid.ok) throw new Error(valid.issues.map(issue => `${issue.field}: ${issue.message}`).join('; '));
    bundle.games.push(game);
    if (evaluateStoredSet(bundle, set).completed) completeSet(bundle, set, now, ids);
  }
  bundle.match.updatedAt = now;
  return bundle;
}

async function findSet(setId: string, repository: TennisRepository) {
  for (const match of await repository.listMatches()) {
    const bundle = await repository.getMatchBundle(match.id);
    const set = bundle?.sets.find(item => item.id === setId);
    if (bundle && set) {
      const copy = structuredClone(bundle);
      return { bundle: copy, set: copy.sets.find(item => item.id === setId)! };
    }
  }
  throw new Error('Set not found');
}

export type TieBreakInput = Pick<TieBreak, 'setId' | 'kind' | 'playerPoints' | 'opponentPoints' | 'netErrors' | 'wideErrors' | 'longErrors' | 'doubleFaults'>;
export async function completeTieBreak(input: TieBreakInput, { repository, clock, ids }: MatchServiceDeps): Promise<MatchBundle> {
  const { bundle, set } = await findSet(input.setId, repository);
  if (set.matchId !== bundle.match.id) throw new Error('Set does not belong to match');
  if (bundle.match.status !== 'active' || set.status !== 'active' || set.tieBreakId || bundle.tieBreaks.some(t => t.setId === set.id)) throw new Error('Set is not active or already has a tie-break');
  const expected = set.kind === 'standard' ? 'standard' : 'super';
  if (input.kind !== expected) throw new Error(`Expected a ${expected} tie-break`);
  const current = evaluateStoredSet(bundle, set);
  if (expected === 'standard' && (current.playerGames !== 6 || current.opponentGames !== 6)) throw new Error('Standard tie-break requires six games all');
  if (expected === 'super' && bundle.games.some(game => game.setId === set.id)) throw new Error('Super tie-break set cannot have games');
  if (expected === 'super') {
    const prior = bundle.sets.filter(item => item.ordinal < set.ordinal && item.status === 'completed').map(item => evaluateStoredSet(bundle, item));
    const match = evaluateMatch(bundle.match.format, prior);
    if (bundle.match.format !== 'twoSetsSuperTiebreak' || match.complete || match.playerSets !== 1 || match.opponentSets !== 1) throw new Error('Super tie-break requires split completed standard sets');
  }
  for (const field of ['netErrors', 'wideErrors', 'longErrors', 'doubleFaults'] as const) {
    const value = input[field];
    if (value !== null && (!Number.isInteger(value) || value < 0)) throw new Error(`${field} must be a non-negative integer or null`);
  }
  const now = clock.now();
  const tieBreak: TieBreak = { ...input, id: ids.next(), createdAt: now, updatedAt: now };
  if (!evaluateSet(bundle.games.filter(game => game.setId === set.id), tieBreak).completed) throw new Error('Invalid tie-break points');
  set.tieBreakId = tieBreak.id; bundle.tieBreaks.push(tieBreak);
  completeSet(bundle, set, now, ids);
  bundle.match.updatedAt = now;
  await repository.saveMatchBundle(bundle);
  return bundle;
}

export async function endSetEarly(setId: string, { repository, clock, ids }: MatchServiceDeps): Promise<MatchBundle> {
  const { bundle, set } = await findSet(setId, repository);
  if (bundle.match.status !== 'active' || set.status !== 'active') throw new Error('Set is not active');
  const now = clock.now();
  set.status = 'unfinished'; set.updatedAt = now;
  if (bundle.match.format !== 'oneSet') bundle.sets.push({ id: ids.next(), matchId: bundle.match.id, ordinal: Math.max(...bundle.sets.map(item => item.ordinal)) + 1, kind: set.kind, status: 'active', tieBreakId: null, createdAt: now, updatedAt: now });
  bundle.match.updatedAt = now;
  await repository.saveMatchBundle(bundle);
  return bundle;
}

export async function finishMatch(id: string, { repository, clock }: MatchServiceDeps): Promise<MatchBundle> {
  const found = await repository.getMatchBundle(id);
  if (!found) throw new Error('Match not found');
  const bundle = structuredClone(found);
  if (bundle.match.status !== 'active') throw new Error('Match is not active');
  const now = clock.now();
  bundle.match.status = 'completed'; bundle.match.updatedAt = now;
  for (const set of bundle.sets.filter(item => item.status === 'active')) { set.status = 'unfinished'; set.updatedAt = now; }
  await repository.saveMatchBundle(bundle);
  return bundle;
}

export async function updateComments(id: string, comments: string | null, { repository, clock }: MatchServiceDeps): Promise<MatchBundle> {
  const found = await repository.getMatchBundle(id);
  if (!found) throw new Error('Match not found');
  const bundle = structuredClone(found);
  if (comments !== null && typeof comments !== 'string') throw new Error('Comments must be text or null');
  bundle.match.comments = comments; bundle.match.updatedAt = clock.now();
  await repository.saveMatchBundle(bundle);
  return bundle;
}

export type GamePatch = Partial<Pick<Game, 'server' | 'result' | 'score' | 'netErrors' | 'wideErrors' | 'longErrors' | 'doubleFaults' | 'failedReturns'>>;
export interface GameConflict { type: 'serverChanged' | 'setOutcomeInvalidated' | 'structureInvalidated' | 'matchOutcomeInvalidated'; message: string; gameId?: string; setId?: string; tieBreakId?: string }

async function findGame(id: string, repository: TennisRepository): Promise<MatchBundle> {
  for (const match of await repository.listMatches()) {
    const bundle = await repository.getMatchBundle(match.id);
    if (bundle?.games.some(game => game.id === id)) return structuredClone(bundle);
  }
  throw new Error('Game not found');
}

function correctionConflicts(before: MatchBundle, after: MatchBundle, corrected: Pick<Game, 'setId' | 'ordinal'> | null): GameConflict[] {
  const conflicts: GameConflict[] = [];
  const ordered = (bundle: MatchBundle) => [...bundle.games].sort((a, b) => (bundle.sets.find(s => s.id === a.setId)?.ordinal ?? 0) - (bundle.sets.find(s => s.id === b.setId)?.ordinal ?? 0) || a.ordinal - b.ordinal);
  const oldGames = ordered(before), newGames = ordered(after);
  for (const [index, game] of newGames.entries()) {
    const previous = oldGames.findIndex(item => item.id === game.id);
    if (previous >= 0) {
      const oldExpected = previous ? inferServer(oldGames[previous - 1].server, 1) : before.match.firstServer;
      const newExpected = index ? inferServer(newGames[index - 1].server, 1) : after.match.firstServer;
      if (oldExpected !== newExpected || previous % 2 !== index % 2) conflicts.push({ type: 'serverChanged', gameId: game.id, message: 'The expected server shifts for a later game' });
    }
  }
  for (const set of before.sets) {
    const prior = evaluateStoredSet(before, set), next = evaluateStoredSet(after, set);
    const outcomeChanged = prior.completed !== next.completed || prior.winner !== next.winner;
    if (set.status !== 'unfinished' && outcomeChanged) conflicts.push({ type: 'setOutcomeInvalidated', setId: set.id, message: `Set ${set.ordinal} outcome changes` });
    if (set.status === 'completed' && prior.completed && (prior.completed !== next.completed || prior.winner !== next.winner)) {
      for (const later of before.sets.filter(item => item.ordinal > set.ordinal)) {
        conflicts.push({ type: 'structureInvalidated', setId: later.id, message: `Later set ${later.ordinal} (${later.id}) depends on set ${set.ordinal}` });
        for (const tie of before.tieBreaks.filter(item => item.setId === later.id)) conflicts.push({ type: 'structureInvalidated', setId: later.id, tieBreakId: tie.id, message: `Later tie-break ${tie.id} in set ${later.ordinal} is affected` });
        for (const game of before.games.filter(item => item.setId === later.id)) conflicts.push({ type: 'structureInvalidated', setId: later.id, gameId: game.id, message: `Later game ${game.id} in set ${later.ordinal} is affected` });
      }
    }
    const tie = before.tieBreaks.find(t => t.id === set.tieBreakId);
    const games = after.games.filter(g => g.setId === set.id);
    const oldSetGames = before.games.filter(g => g.setId === set.id);
    const eligible = (items: Game[]) => items.filter(g => g.result === 'won').length === 6 && items.filter(g => g.result === 'lost').length === 6;
    const eligibilityChanged = tie?.kind === 'standard' && eligible(oldSetGames) !== eligible(games);
    if (corrected && set.id === corrected.setId && (outcomeChanged || eligibilityChanged)) {
      if (tie && !(tie.kind === 'standard' && !eligible(games))) conflicts.push({ type: 'structureInvalidated', setId: set.id, tieBreakId: tie.id, message: `Tie-break ${tie.id} in set ${set.ordinal} is affected` });
      for (const game of oldSetGames.filter(item => item.ordinal > corrected.ordinal)) {
        if (!conflicts.some(item => item.type === 'serverChanged' && item.gameId === game.id)) conflicts.push({ type: 'structureInvalidated', setId: set.id, gameId: game.id, message: `Later game ${game.id} in set ${set.ordinal} is affected` });
      }
    }
    const chronological = [...games].sort((a, b) => a.ordinal - b.ordinal);
    const completionIndex = set.kind === 'standard' ? chronological.findIndex((_, index) => evaluateSet(chronological.slice(0, index + 1), null).completed) : -1;
    if (completionIndex >= 0) {
      for (const game of chronological.slice(completionIndex + 1)) {
        const existing = conflicts.find(item => item.type === 'structureInvalidated' && item.setId === set.id && item.gameId === game.id);
        const message = `Game ${game.id} in set ${set.ordinal} is after the set ended`;
        if (existing) existing.message = message;
        else conflicts.push({ type: 'structureInvalidated', setId: set.id, gameId: game.id, message });
      }
    }
    if (tie?.kind === 'standard' && !eligible(games)) conflicts.push({ type: 'structureInvalidated', setId: set.id, tieBreakId: tie.id, message: `Set ${set.ordinal} no longer qualifies for tie-break ${tie.id}` });
  }
  const oldMatch = evaluateStoredMatch(before), newMatch = evaluateStoredMatch(after);
  if (oldMatch.complete !== newMatch.complete || oldMatch.winner !== newMatch.winner) conflicts.push({ type: 'matchOutcomeInvalidated', message: 'Match outcome or completion changes' });
  return conflicts;
}

/** A correction that completes the active set of an active match finalises it exactly as adding the deciding game would. Other matches and sets are only edited in place. */
function finaliseCorrectedActiveSet(bundle: MatchBundle, now: string, ids: IdGenerator) {
  if (bundle.match.status !== 'active') return;
  const set = bundle.sets.find(item => item.status === 'active');
  if (set && set.kind === 'standard' && evaluateStoredSet(bundle, set).completed) completeSet(bundle, set, now, ids);
}

export async function updateGame(gameId: string, patch: GamePatch, { repository, clock, ids }: MatchServiceDeps, confirmed = false): Promise<{ bundle: MatchBundle; conflicts: GameConflict[] }> {
  const before = await findGame(gameId, repository);
  const bundle = structuredClone(before);
  const game = bundle.games.find(item => item.id === gameId)!;
  const allowed = ['server', 'result', 'score', 'netErrors', 'wideErrors', 'longErrors', 'doubleFaults', 'failedReturns'];
  if (!patch || Object.keys(patch).some(key => !allowed.includes(key))) throw new Error('Invalid game patch');
  Object.assign(game, patch, { updatedAt: clock.now() });
  if (game.result !== 'won' && game.result !== 'lost') throw new Error('Invalid game result');
  const valid = validateGame(game);
  if (!valid.ok) throw new Error(valid.issues.map(issue => `${issue.field}: ${issue.message}`).join('; '));
  const conflicts = correctionConflicts(before, bundle, before.games.find(item => item.id === gameId)!);
  if (conflicts.length && !confirmed) return { bundle: before, conflicts };
  finaliseCorrectedActiveSet(bundle, game.updatedAt, ids);
  bundle.match.updatedAt = game.updatedAt;
  await repository.saveMatchBundle(bundle);
  return { bundle, conflicts };
}

export async function deleteGame(gameId: string, { repository, clock, ids }: MatchServiceDeps, confirmed = false): Promise<{ bundle: MatchBundle; conflicts: GameConflict[] }> {
  const before = await findGame(gameId, repository);
  const bundle = structuredClone(before);
  bundle.games = bundle.games.filter(game => game.id !== gameId);
  const conflicts = correctionConflicts(before, bundle, before.games.find(item => item.id === gameId)!);
  if (conflicts.length && !confirmed) return { bundle: before, conflicts };
  const now = clock.now();
  finaliseCorrectedActiveSet(bundle, now, ids);
  bundle.match.updatedAt = now;
  await repository.saveMatchBundle(bundle);
  return { bundle, conflicts };
}

/** Records the new format can no longer hold: anything after the set that already decides the match, and super tie-break sets outside the super tie-break format. */
function formatStructureConflicts(bundle: MatchBundle): GameConflict[] {
  const conflicts: GameConflict[] = [];
  const flagged = new Set<string>();
  const flag = (set: TennisSet, reason: string) => {
    if (flagged.has(set.id)) return; flagged.add(set.id);
    conflicts.push({ type: 'structureInvalidated', setId: set.id, message: `Set ${set.ordinal} ${reason}` });
    for (const tie of bundle.tieBreaks.filter(item => item.setId === set.id)) conflicts.push({ type: 'structureInvalidated', setId: set.id, tieBreakId: tie.id, message: `Tie-break ${tie.id} in set ${set.ordinal} ${reason}` });
    for (const game of bundle.games.filter(item => item.setId === set.id)) conflicts.push({ type: 'structureInvalidated', setId: set.id, gameId: game.id, message: `Game ${game.id} in set ${set.ordinal} ${reason}` });
  };
  const deciding = decidingStoredSet(bundle);
  if (deciding) for (const set of bundle.sets.filter(item => item.ordinal > deciding.ordinal).sort((a, b) => a.ordinal - b.ordinal)) flag(set, `comes after set ${deciding.ordinal} already decides the match under the new format`);
  if (bundle.match.format !== 'twoSetsSuperTiebreak') for (const set of bundle.sets.filter(item => item.kind === 'decidingSuperTiebreak')) flag(set, 'is a super tie-break set that does not fit the new format');
  return conflicts;
}

export type CorrectionResult = { bundle: MatchBundle; conflicts: GameConflict[] };
export interface MatchDetailsPatch { opponentName?: string; playedAt?: string; format?: MatchFormat }

/** Edits match metadata in place. Never changes `status`; a format change that alters the derived outcome or orphans a super tie-break set needs confirmation. */
export async function updateMatchDetails(id: string, patch: MatchDetailsPatch, { repository, clock, ids }: MatchServiceDeps, confirmed = false): Promise<CorrectionResult> {
  const found = await repository.getMatchBundle(id);
  if (!found) throw new Error('Match not found');
  const before = structuredClone(found); const bundle = structuredClone(found);
  const now = clock.now();
  if (patch.playedAt !== undefined) {
    if (!Number.isFinite(Date.parse(patch.playedAt))) throw new Error('Enter a valid date and time');
    bundle.match.playedAt = patch.playedAt;
  }
  if (patch.format !== undefined) {
    if (!MATCH_FORMATS.includes(patch.format)) throw new Error('Choose a valid match format');
    bundle.match.format = patch.format;
  }
  if (patch.opponentName !== undefined) {
    const name = normalizeOpponentName(patch.opponentName);
    if (!name) throw new Error('Enter an opponent name');
    if (name.toLowerCase() !== bundle.opponent.normalizedName.toLowerCase()) {
      const existing = (await repository.listOpponents()).find(o => o.normalizedName.toLowerCase() === name.toLowerCase());
      bundle.opponent = existing ?? { id: ids.next(), name, normalizedName: name.toLowerCase(), createdAt: now, updatedAt: now };
      bundle.match.opponentId = bundle.opponent.id;
    }
  }
  const conflicts = correctionConflicts(before, bundle, null);
  if (bundle.match.format !== before.match.format) conflicts.push(...formatStructureConflicts(bundle));
  if (conflicts.length && !confirmed) return { bundle: before, conflicts };
  bundle.match.updatedAt = now;
  await repository.saveMatchBundle(bundle);
  return { bundle, conflicts };
}

export type TieBreakPatch = Pick<TieBreak, 'playerPoints' | 'opponentPoints' | 'netErrors' | 'wideErrors' | 'longErrors' | 'doubleFaults'>;

/** Corrects a recorded tie-break in place (points must still decide it). Never changes `status`. */
export async function updateTieBreak(tieBreakId: string, patch: TieBreakPatch, { repository, clock }: MatchServiceDeps, confirmed = false): Promise<CorrectionResult> {
  let before: MatchBundle | undefined;
  for (const match of await repository.listMatches()) {
    const candidate = await repository.getMatchBundle(match.id);
    if (candidate?.tieBreaks.some(item => item.id === tieBreakId)) { before = structuredClone(candidate); break; }
  }
  if (!before) throw new Error('Tie-break not found');
  const bundle = structuredClone(before);
  const tieBreak = bundle.tieBreaks.find(item => item.id === tieBreakId)!;
  for (const field of ['playerPoints', 'opponentPoints', 'netErrors', 'wideErrors', 'longErrors', 'doubleFaults'] as const) {
    const value = patch[field];
    if ((value !== null || field === 'playerPoints' || field === 'opponentPoints') && (!Number.isInteger(value) || (value as number) < 0)) throw new Error(`${field} must be a non-negative integer${field.endsWith('Points') ? '' : ' or null'}`);
  }
  Object.assign(tieBreak, { playerPoints: patch.playerPoints, opponentPoints: patch.opponentPoints, netErrors: patch.netErrors, wideErrors: patch.wideErrors, longErrors: patch.longErrors, doubleFaults: patch.doubleFaults, updatedAt: clock.now() });
  if (!evaluateSet(bundle.games.filter(game => game.setId === tieBreak.setId), tieBreak).completed) throw new Error('Invalid tie-break points');
  const conflicts = correctionConflicts(before, bundle, null);
  if (conflicts.length && !confirmed) return { bundle: before, conflicts };
  bundle.match.updatedAt = tieBreak.updatedAt;
  await repository.saveMatchBundle(bundle);
  return { bundle, conflicts };
}
