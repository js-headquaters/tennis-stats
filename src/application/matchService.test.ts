import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../infrastructure/db/database';
import { abandonActiveMatch, startMatch } from './matchService';

const clock = { now: () => '2026-01-01T12:00:00.000Z' };
let counter = 0;
const ids = { next: () => `id-${++counter}` };
const repos: Awaited<ReturnType<typeof openDatabase>>[] = [];
afterEach(() => { repos.forEach(repo => repo.close()); repos.length = 0; });
async function setup() { const repository = await openDatabase(`service-${++counter}`); repos.push(repository); return { repository, clock, ids }; }
const input = { opponentName: ' Alex ', playedAt: clock.now(), firstServer: 'player' as const };

describe('match services', () => {
  it('creates an opponent and default match with one standard set', async () => {
    const deps = await setup(); const result = await startMatch(input, deps);
    expect(result.opponent).toMatchObject({ name: 'Alex', normalizedName: 'alex' });
    expect(result.match).toMatchObject({ status: 'active', format: 'twoSetsSuperTiebreak', firstServer: 'player' });
    expect(result.sets).toMatchObject([{ ordinal: 1, kind: 'standard', status: 'active' }]);
    expect(await deps.repository.getActiveMatch()).toEqual(result);
  });
  it('reuses opponents case-insensitively and preserves records on abandonment', async () => {
    const deps = await setup(); const first = await startMatch(input, deps);
    await abandonActiveMatch(first.match.id, deps);
    expect(await deps.repository.getMatchBundle(first.match.id)).toMatchObject({ match: { status: 'abandoned' }, sets: first.sets });
    const second = await startMatch({ ...input, opponentName: 'aLEX' }, deps);
    expect(second.opponent.id).toBe(first.opponent.id);
    expect(await deps.repository.listOpponents()).toHaveLength(1);
  });
  it('rejects a second active match with an actionable conflict', async () => {
    const deps = await setup(); await startMatch(input, deps);
    await expect(startMatch(input, deps)).rejects.toThrow(/complete or abandon/i);
    expect(await deps.repository.listMatches()).toHaveLength(1);
  });
});
