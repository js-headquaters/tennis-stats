import type { Game, MatchBundle, MatchFormat, Server, TennisSet, TieBreak } from './model';

export interface SetEvaluation {
  kind: 'standard' | 'decidingSuperTiebreak';
  playerGames: number;
  opponentGames: number;
  winner: 'player' | 'opponent' | null;
  completed: boolean;
}

export interface MatchEvaluation {
  complete: boolean;
  winner: 'player' | 'opponent' | null;
  playerSets: number;
  opponentSets: number;
  requiresManualCompletion: boolean;
}

export type CorrectionConflict =
  | { type: 'serverChanged'; gameId: string; beforeServer: Server; afterServer: Server }
  | { type: 'setOutcomeInvalidated'; beforeWinner: 'player' | 'opponent' | null; afterWinner: 'player' | 'opponent' | null };

export function inferServer(first: Server, zeroBasedGameIndex: number): Server {
  if (!Number.isInteger(zeroBasedGameIndex) || zeroBasedGameIndex < 0) throw new RangeError('Game index must be a non-negative integer');
  return zeroBasedGameIndex % 2 === 0 ? first : first === 'player' ? 'opponent' : 'player';
}

function tieBreakWinner(tieBreak: TieBreak | null, kind: TieBreak['kind']): 'player' | 'opponent' | null {
  if (!tieBreak || tieBreak.kind !== kind) return null;
  const target = kind === 'super' ? 10 : 7;
  const { playerPoints, opponentPoints } = tieBreak;
  if (![playerPoints, opponentPoints].every((points) => Number.isInteger(points) && points >= 0)) return null;
  const high = Math.max(playerPoints, opponentPoints);
  const margin = Math.abs(playerPoints - opponentPoints);
  if (high < target || margin < 2 || (high > target && margin !== 2)) return null;
  return tieBreak.playerPoints > tieBreak.opponentPoints ? 'player' : 'opponent';
}

export function evaluateSet(games: Game[], tieBreak: TieBreak | null): SetEvaluation {
  if (tieBreak?.kind === 'super' && games.length === 0) {
    const winner = tieBreakWinner(tieBreak, 'super');
    return { kind: 'decidingSuperTiebreak', playerGames: 0, opponentGames: 0, winner, completed: winner !== null };
  }
  const playerGames = games.filter((game) => game.result === 'won').length;
  const opponentGames = games.length - playerGames;
  let winner: SetEvaluation['winner'] = null;
  if (Math.max(playerGames, opponentGames) >= 6 && Math.abs(playerGames - opponentGames) >= 2) {
    winner = playerGames > opponentGames ? 'player' : 'opponent';
  } else if (playerGames === 6 && opponentGames === 6) {
    const deciding = tieBreakWinner(tieBreak, 'standard');
    if (deciding) winner = deciding;
  }
  const tiebreakSet = playerGames === 6 && opponentGames === 6 && winner !== null;
  return { kind: 'standard', playerGames: playerGames + (tiebreakSet && winner === 'player' ? 1 : 0), opponentGames: opponentGames + (tiebreakSet && winner === 'opponent' ? 1 : 0), winner, completed: winner !== null };
}

export function evaluateMatch(format: MatchFormat, sets: SetEvaluation[]): MatchEvaluation {
  if (format === 'twoSetsSuperTiebreak') {
    const standard = sets.filter((set) => set.kind === 'standard').slice(0, 2);
    let playerSets = standard.filter((set) => set.completed && set.winner === 'player').length;
    let opponentSets = standard.filter((set) => set.completed && set.winner === 'opponent').length;
    let winner: SetEvaluation['winner'] = playerSets === 2 ? 'player' : opponentSets === 2 ? 'opponent' : null;
    if (playerSets === 1 && opponentSets === 1) {
      const secondIndex = sets.indexOf(standard[1]);
      const deciding = sets.slice(secondIndex + 1).find((set) => set.kind === 'decidingSuperTiebreak' && set.completed && set.winner !== null);
      winner = deciding?.winner ?? null;
      if (winner === 'player') playerSets++;
      if (winner === 'opponent') opponentSets++;
    }
    return { complete: winner !== null, winner, playerSets, opponentSets, requiresManualCompletion: false };
  }
  const playerSets = sets.filter((set) => set.kind === 'standard' && set.completed && set.winner === 'player').length;
  const opponentSets = sets.filter((set) => set.kind === 'standard' && set.completed && set.winner === 'opponent').length;
  const required = format === 'oneSet' ? 1 : format === 'bestOfThree' ? 2 : Infinity;
  if (format === 'openPractice') return { complete: false, winner: null, playerSets, opponentSets, requiresManualCompletion: true };
  const winner = playerSets >= required ? 'player' : opponentSets >= required ? 'opponent' : null;
  return { complete: winner !== null, winner, playerSets, opponentSets, requiresManualCompletion: false };
}

export function findCorrectionConflicts(before: Game[], after: Game[]): CorrectionConflict[] {
  const conflicts: CorrectionConflict[] = [];
  const sortedBefore = [...before].sort((a, b) => a.ordinal - b.ordinal);
  const sortedAfter = [...after].sort((a, b) => a.ordinal - b.ordinal);
  const firstServer = sortedBefore[0]?.server ?? sortedAfter[0]?.server;
  if (firstServer) {
    const beforeIndex = new Map(sortedBefore.map((game, index) => [game.id, index]));
    sortedAfter.forEach((game, index) => {
      const oldIndex = beforeIndex.get(game.id);
      if (oldIndex !== undefined) {
        const expectedBefore = inferServer(firstServer, oldIndex);
        const expectedAfter = inferServer(firstServer, index);
        if (expectedBefore !== expectedAfter) {
          conflicts.push({ type: 'serverChanged', gameId: game.id, beforeServer: expectedBefore, afterServer: expectedAfter });
        }
      }
    });
  }
  const beforeSet = evaluateSet(before, null);
  const afterSet = evaluateSet(after, null);
  if (beforeSet.completed && (!afterSet.completed || afterSet.winner !== beforeSet.winner)) {
    conflicts.push({ type: 'setOutcomeInvalidated', beforeWinner: beforeSet.winner, afterWinner: afterSet.winner });
  }
  return conflicts;
}

/** The single evaluator for a STORED set: its own tie-break (by `tieBreakId`), its stored kind, and no winner while unfinished. */
export function evaluateStoredSet(bundle: MatchBundle, set: TennisSet): SetEvaluation {
  const evaluation = evaluateSet(bundle.games.filter(game => game.setId === set.id), bundle.tieBreaks.find(t => t.id === set.tieBreakId) ?? null);
  return set.status === 'unfinished' ? { ...evaluation, kind: set.kind, completed: false, winner: null } : { ...evaluation, kind: set.kind };
}

/** Stored sets that count toward the match result (unfinished sets excluded), in ordinal order. */
function countedSets(bundle: MatchBundle) {
  return [...bundle.sets].sort((a, b) => a.ordinal - b.ordinal).filter(set => set.status !== 'unfinished');
}

/** The single evaluator for a STORED match under `format` (defaults to the stored format). */
export function evaluateStoredMatch(bundle: MatchBundle, format: MatchFormat = bundle.match.format): MatchEvaluation {
  return evaluateMatch(format, countedSets(bundle).map(set => evaluateStoredSet(bundle, set)));
}

/** The first counted set at which the match is already decided under `format`, or null when it never is. */
export function decidingStoredSet(bundle: MatchBundle, format: MatchFormat = bundle.match.format): TennisSet | null {
  const sets = countedSets(bundle);
  for (let index = 0; index < sets.length; index++) {
    if (evaluateMatch(format, sets.slice(0, index + 1).map(set => evaluateStoredSet(bundle, set))).complete) return sets[index];
  }
  return null;
}
