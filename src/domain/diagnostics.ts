import type { DiagnosticText, MatchDiagnostic } from './model';

export const DIAGNOSTIC_TEXT_LIMIT = 262144;
export const DIAGNOSTIC_BODY_LIMIT = 8192;
export const DIAGNOSTICS_PER_MATCH = 500;

export function boundText(value: string, limit: number = DIAGNOSTIC_TEXT_LIMIT): DiagnosticText {
  return value.length <= limit ? { value, truncated: false, originalLength: value.length } : { value: value.slice(0, limit), truncated: true, originalLength: value.length };
}

/** Ids to delete so that at most `cap` rows remain: oldest successes first, then the oldest of the rest. */
export function diagnosticsToDelete(rows: Pick<MatchDiagnostic, 'id' | 'startedAt' | 'outcome'>[], cap: number = DIAGNOSTICS_PER_MATCH): string[] {
  const excess = rows.length - cap;
  if (excess <= 0) return [];
  const oldest = rows.map((r, i) => ({ r, i })).sort((a, b) => (a.r.startedAt < b.r.startedAt ? -1 : a.r.startedAt > b.r.startedAt ? 1 : a.i - b.i)).map((x) => x.r);
  return [...oldest.filter((r) => r.outcome === 'success'), ...oldest.filter((r) => r.outcome !== 'success')].slice(0, excess).map((r) => r.id);
}
