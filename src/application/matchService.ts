import type { Clock, IdGenerator, TennisRepository } from './ports';
import type { MatchBundle, MatchFormat, Server } from '../domain/model';
import { normalizeOpponentName } from '../domain/validation';

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
