import type { Game, MatchFormat, Server, TieBreak } from './model';

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
  if (Math.max(tieBreak.playerPoints, tieBreak.opponentPoints) < target || Math.abs(tieBreak.playerPoints - tieBreak.opponentPoints) < 2) return null;
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
    const standard = sets.filter((set) => set.kind === 'standard' && set.completed && set.winner !== null).slice(0, 2);
    let playerSets = standard.filter((set) => set.winner === 'player').length;
    let opponentSets = standard.filter((set) => set.winner === 'opponent').length;
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
  const playerSets = sets.filter((set) => set.completed && set.winner === 'player').length;
  const opponentSets = sets.filter((set) => set.completed && set.winner === 'opponent').length;
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
