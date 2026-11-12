import type { Game, ValidationIssue, ValidationResult } from './model';

export function normalizeOpponentName(name: string): string {
  return name.trim();
}

export function validateGame(input: Game): ValidationResult<Game> {
  const issues: ValidationIssue[] = [];
  for (const field of ['id', 'setId', 'createdAt', 'updatedAt'] as const) {
    if (typeof input[field] !== 'string' || input[field].trim() === '') issues.push({ field, message: 'Must be a non-empty string' });
  }
  if (input.server !== 'player' && input.server !== 'opponent') issues.push({ field: 'server', message: "Must be 'player' or 'opponent'" });
  if (!Number.isInteger(input.ordinal) || input.ordinal < 0) issues.push({ field: 'ordinal', message: 'Must be a non-negative integer' });
  const allowedPoints = ['0', '15', '30', '40', 'AD'];
  if (input.score !== null && (!input.score || typeof input.score !== 'object' || !allowedPoints.includes(input.score.player) || !allowedPoints.includes(input.score.opponent))) {
    issues.push({ field: 'score', message: "Must be null or a pair of allowed score strings ('0', '15', '30', '40', 'AD')" });
  }
  for (const field of ['firstServesIn', 'firstServesTotal', 'secondServesIn', 'secondServesTotal', 'aces', 'doubleFaults', 'winners', 'unforcedErrors', 'failedReturns'] as const) {
    const value = input[field];
    if (value !== null && (!Number.isInteger(value) || value < 0)) issues.push({ field, message: 'Must be a non-negative integer or null' });
  }
  if (input.failedReturns !== null && input.server === 'player') issues.push({ field: 'failedReturns', message: 'Only valid when the opponent served' });
  if (input.doubleFaults !== null && input.server === 'opponent') issues.push({ field: 'doubleFaults', message: 'Only valid when the player served' });
  return issues.length ? { ok: false, issues } : { ok: true, value: input };
}
