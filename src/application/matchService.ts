import type { Clock, IdGenerator, TennisRepository } from './ports';
import type { Game, MatchBundle, MatchFormat, Server, TennisSet, TieBreak } from '../domain/model';
import { normalizeOpponentName, validateGame } from '../domain/validation';
import { evaluateMatch, evaluateSet, inferServer } from '../domain/scoring';

export interface MatchServiceDeps { repository: TennisRepository; clock: Clock; ids: IdGenerator }
export interface StartMatchInput { opponentName?: string; opponentId?: string; playedAt: string; format?: MatchFormat; firstServer: Server }
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

export type GameInput = Pick<Game, 'result' | 'netErrors' | 'wideErrors' | 'longErrors' | 'doubleFaults' | 'failedReturns'> & { server?: Server; score?: Game['score'] };

function setEvaluation(bundle: MatchBundle, set: TennisSet) {
  const evaluation = evaluateSet(bundle.games.filter(game => game.setId === set.id), bundle.tieBreaks.find(t => t.id === set.tieBreakId) ?? null);
  return set.status === 'unfinished' ? { ...evaluation, kind: set.kind, completed: false, winner: null } : { ...evaluation, kind: set.kind };
}

function completeSet(bundle: MatchBundle, set: TennisSet, now: string, ids: IdGenerator) {
  set.status = 'completed'; set.updatedAt = now;
  const evaluations = bundle.sets.filter(item => item.status !== 'unfinished').map(item => setEvaluation(bundle, item));
  const match = evaluateMatch(bundle.match.format, evaluations);
  if (match.complete) { bundle.match.status = 'completed'; return; }
  const kind = bundle.match.format === 'twoSetsSuperTiebreak' && match.playerSets === 1 && match.opponentSets === 1 ? 'decidingSuperTiebreak' : 'standard';
  bundle.sets.push({ id: ids.next(), matchId: bundle.match.id, ordinal: Math.max(...bundle.sets.map(item => item.ordinal)) + 1, kind, status: 'active', tieBreakId: null, createdAt: now, updatedAt: now });
}

export async function addGames(matchId: string, inputs: GameInput[], { repository, clock, ids }: MatchServiceDeps): Promise<MatchBundle> {
  const found = await repository.getMatchBundle(matchId);
  if (!found) throw new Error('Match not found');
  const bundle = structuredClone(found);
  if (bundle.match.status !== 'active') throw new Error('Match is not active');
  if (!Array.isArray(inputs) || inputs.length === 0) throw new Error('Add at least one game');
  const now = clock.now();
  for (const input of inputs) {
    const set = bundle.sets.find(item => item.status === 'active');
    if (!set || set.kind !== 'standard' || bundle.match.status !== 'active') throw new Error('No active standard set for game entry');
    const score = setEvaluation(bundle, set);
    if (score.playerGames === 6 && score.opponentGames === 6) throw new Error('Complete the tie-break before adding games');
    const existing = bundle.games.filter(game => game.setId === set.id);
    const last = [...bundle.games].sort((a, b) => (bundle.sets.find(s => s.id === b.setId)?.ordinal ?? 0) - (bundle.sets.find(s => s.id === a.setId)?.ordinal ?? 0) || b.ordinal - a.ordinal)[0];
    const game: Game = { ...input, id: ids.next(), setId: set.id, ordinal: Math.max(0, ...existing.map(item => item.ordinal)) + 1, server: input.server ?? (last ? inferServer(last.server, 1) : bundle.match.firstServer), score: input.score ?? null, createdAt: now, updatedAt: now };
    if (game.result !== 'won' && game.result !== 'lost') throw new Error('Choose whether the game was won or lost');
    const valid = validateGame(game);
    if (!valid.ok) throw new Error(valid.issues.map(issue => `${issue.field}: ${issue.message}`).join('; '));
    bundle.games.push(game);
    if (setEvaluation(bundle, set).completed) completeSet(bundle, set, now, ids);
  }
  bundle.match.updatedAt = now;
  await repository.saveMatchBundle(bundle);
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
  const current = setEvaluation(bundle, set);
  if (expected === 'standard' && (current.playerGames !== 6 || current.opponentGames !== 6)) throw new Error('Standard tie-break requires six games all');
  if (expected === 'super' && bundle.games.some(game => game.setId === set.id)) throw new Error('Super tie-break set cannot have games');
  if (expected === 'super') {
    const prior = bundle.sets.filter(item => item.ordinal < set.ordinal && item.status === 'completed').map(item => setEvaluation(bundle, item));
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
export interface GameConflict { type: 'serverChanged' | 'setOutcomeInvalidated' | 'structureInvalidated' | 'matchOutcomeInvalidated'; message: string; gameId?: string }

async function findGame(id: string, repository: TennisRepository): Promise<MatchBundle> {
  for (const match of await repository.listMatches()) {
    const bundle = await repository.getMatchBundle(match.id);
    if (bundle?.games.some(game => game.id === id)) return structuredClone(bundle);
  }
  throw new Error('Game not found');
}

function correctionConflicts(before: MatchBundle, after: MatchBundle): GameConflict[] {
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
    const prior = setEvaluation(before, set), next = setEvaluation(after, set);
    if (set.status !== 'unfinished' && (prior.completed !== next.completed || prior.winner !== next.winner)) conflicts.push({ type: 'setOutcomeInvalidated', message: `Set ${set.ordinal} outcome changes` });
    const tie = before.tieBreaks.find(t => t.id === set.tieBreakId);
    const games = after.games.filter(g => g.setId === set.id);
    const chronological = [...games].sort((a, b) => a.ordinal - b.ordinal);
    if (chronological.some((_, index) => index < chronological.length - 1 && evaluateSet(chronological.slice(0, index + 1), null).completed)) conflicts.push({ type: 'structureInvalidated', message: `Set ${set.ordinal} has games after it ended` });
    if (tie?.kind === 'standard' && (games.filter(g => g.result === 'won').length !== 6 || games.filter(g => g.result === 'lost').length !== 6)) conflicts.push({ type: 'structureInvalidated', message: `Set ${set.ordinal} no longer qualifies for its tie-break` });
  }
  const evaluate = (bundle: MatchBundle) => evaluateMatch(bundle.match.format, bundle.sets.filter(s => s.status !== 'unfinished').map(s => setEvaluation(bundle, s)));
  const oldMatch = evaluate(before), newMatch = evaluate(after);
  if (oldMatch.complete !== newMatch.complete || oldMatch.winner !== newMatch.winner) conflicts.push({ type: 'matchOutcomeInvalidated', message: 'Match outcome or completion changes' });
  return conflicts;
}

export async function updateGame(gameId: string, patch: GamePatch, { repository, clock }: MatchServiceDeps, confirmed = false): Promise<{ bundle: MatchBundle; conflicts: GameConflict[] }> {
  const before = await findGame(gameId, repository);
  const bundle = structuredClone(before);
  const game = bundle.games.find(item => item.id === gameId)!;
  const allowed = ['server', 'result', 'score', 'netErrors', 'wideErrors', 'longErrors', 'doubleFaults', 'failedReturns'];
  if (!patch || Object.keys(patch).some(key => !allowed.includes(key))) throw new Error('Invalid game patch');
  Object.assign(game, patch, { updatedAt: clock.now() });
  if (game.result !== 'won' && game.result !== 'lost') throw new Error('Invalid game result');
  const valid = validateGame(game);
  if (!valid.ok) throw new Error(valid.issues.map(issue => `${issue.field}: ${issue.message}`).join('; '));
  const conflicts = correctionConflicts(before, bundle);
  if (conflicts.length && !confirmed) return { bundle: before, conflicts };
  bundle.match.updatedAt = game.updatedAt;
  await repository.saveMatchBundle(bundle);
  return { bundle, conflicts };
}

export async function deleteGame(gameId: string, { repository, clock }: MatchServiceDeps, confirmed = false): Promise<{ bundle: MatchBundle; conflicts: GameConflict[] }> {
  const before = await findGame(gameId, repository);
  const bundle = structuredClone(before);
  bundle.games = bundle.games.filter(game => game.id !== gameId);
  const conflicts = correctionConflicts(before, bundle);
  if (conflicts.length && !confirmed) return { bundle: before, conflicts };
  bundle.match.updatedAt = clock.now();
  await repository.saveMatchBundle(bundle);
  return { bundle, conflicts };
}
