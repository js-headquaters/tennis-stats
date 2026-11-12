import type { Clock, IdGenerator } from '../application/ports';
import { openDatabase } from '../infrastructure/db/database';

export const dependencies = {
  clock: { now: () => new Date().toISOString() } satisfies Clock,
  ids: { next: () => crypto.randomUUID() } satisfies IdGenerator,
  openDatabase,
};
