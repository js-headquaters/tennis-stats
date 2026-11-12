import type { ClearedCounts, EntityType } from '../../application/backupService';

export const ENTITY_LABEL: Record<EntityType, { one: string; many: string; title: string }> = {
  opponents: { one: 'opponent', many: 'opponents', title: 'Opponents' },
  matches: { one: 'match', many: 'matches', title: 'Matches' },
  sets: { one: 'set', many: 'sets', title: 'Sets' },
  games: { one: 'game', many: 'games', title: 'Games' },
  tieBreaks: { one: 'tie-break', many: 'tie-breaks', title: 'Tie-breaks' },
};
/** Display order: the most meaningful counts first. */
export const DISPLAY_ORDER: readonly EntityType[] = ['matches', 'opponents', 'sets', 'games', 'tieBreaks'];

export const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
export const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export function countsText(counts: ClearedCounts): string {
  return [...DISPLAY_ORDER.map(entity => count(counts[entity], ENTITY_LABEL[entity].one, ENTITY_LABEL[entity].many)), count(counts.voiceDrafts, 'pending voice draft', 'pending voice drafts')].join(', ');
}
