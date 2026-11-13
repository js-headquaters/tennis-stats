import { z } from 'zod';
import { GAME_COMMENT_MAX_LENGTH } from '../domain/validation';

/** A recorded count: a non-negative safe integer, or null when unknown. Never defaulted, so a missing key is invalid. */
const metric = z.number().int().nonnegative().nullable();
/** A per-game observation: trimmed, at most GAME_COMMENT_MAX_LENGTH characters once trimmed, and null when blank. */
const comment = z.string().trim().max(GAME_COMMENT_MAX_LENGTH).transform(value => value === '' ? null : value).nullable();

/** One strict draft game: exactly these keys, with the serve metric that does not apply to the server left null. */
export const draftGameSchema = z.object({
  server: z.enum(['player', 'opponent']), result: z.enum(['won', 'lost']),
  unforcedErrors: metric, netErrors: metric, wideErrors: metric, longErrors: metric, doubleFaults: metric, failedReturns: metric,
  comments: comment,
}).strict().refine(game => game.server === 'player' ? game.failedReturns === null : game.doubleFaults === null);

/** Strict, provider-independent parsed draft (version 2). It has no match-level comment. */
export const parsedDraftSchema = z.object({ version: z.literal(2), games: z.array(draftGameSchema), warnings: z.array(z.string()) }).strict();
