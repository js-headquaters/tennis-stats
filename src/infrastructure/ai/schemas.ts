import { z } from 'zod';

const metric = z.number().int().nonnegative().nullable();
const game = z.object({ server: z.enum(['player', 'opponent']), result: z.enum(['won', 'lost']), netErrors: metric, wideErrors: metric, longErrors: metric, doubleFaults: metric, failedReturns: metric, unforcedErrors: metric.default(null), comments: z.string().nullable().default(null) }).strict().refine(value => value.server === 'player' ? value.failedReturns === null : value.doubleFaults === null);
export const parsedDraftSchema = z.object({ version: z.literal(2), games: z.array(game), warnings: z.array(z.string()) }).strict();
